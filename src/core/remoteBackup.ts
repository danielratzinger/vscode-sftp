import * as path from 'path';
import * as fse from 'fs-extra';

/**
 * What the server had, before this machine wrote over it.
 *
 * The extension has always kept the *local* file before a download replaces
 * it, and deliberately not the other way round - keeping the remote before an
 * upload means fetching it first, a transfer for every transfer. That trade is
 * right for a person saving a file they are looking at. It is wrong for a
 * folder being deployed continuously by something nobody is watching, which is
 * what autosync is: by the time a bad write is noticed, the only copy of what
 * was there is on the server, under the thing that replaced it.
 *
 * So: before the first time a session overwrites a given file, the remote
 * bytes are pulled down and kept. **Once per file per session** - the point is
 * the state before this run started, not before each save - which is why a
 * twenty-minute editing session costs one extra fetch per file touched.
 *
 * A file that was not on the server is recorded as absent rather than skipped,
 * because "it did not exist" is also a state to be put back.
 *
 * Restoring is therefore: pick a moment, and for every file captured at or
 * after it, take the *earliest* snapshot from that moment on. By construction
 * that is what the file was before anything in that window touched it.
 */

export interface RemoteBackupOption {
  /** Where every connection's sessions live. */
  root: string;
  /** Which connection's, keyed so two servers never share a history. */
  connectionId: string;
  /** How long a session is kept before it is swept. */
  maxAgeDays: number;
}

export interface Session {
  stamp: string;
  when: number;
  files: number;
}

export interface Snapshot {
  remotePath: string;
  stamp: string;
  /** The file was not on the server at all when the snapshot was taken. */
  absent: boolean;
}

const MANIFEST = '_manifest.jsonl';
const FILES = 'files';

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `2026-09-21-143005`, which sorts the same as it reads. */
export function stampFor(when: Date = new Date()): string {
  return (
    `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}` +
    `-${two(when.getHours())}${two(when.getMinutes())}${two(when.getSeconds())}`
  );
}

/** The moment a stamp names, or NaN if it names nothing. */
export function whenOf(stamp: string): number {
  const parts = stamp.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!parts) {
    return NaN;
  }

  const [, y, mo, d, h, mi, s] = parts;
  return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
}

/**
 * A remote path as a local one, mirrored rather than flattened so a session
 * folder can be read by a person.
 *
 * Every segment that could climb out of the session folder is refused; what a
 * server calls a file is not something to trust with a path join.
 */
export function mirrored(remotePath: string): string {
  const segments = remotePath
    .replace(/\\/g, '/')
    .split('/')
    .map(one => one.replace(/[:*?"<>|]/g, '_'))
    .filter(one => one !== '' && one !== '.' && one !== '..');

  return segments.join(path.sep);
}

function sessionDir(option: RemoteBackupOption, stamp: string): string {
  return path.join(option.root, option.connectionId, stamp);
}

/** Where the bytes of one file, from one session, are kept. */
export function storedAt(
  option: RemoteBackupOption,
  stamp: string,
  remotePath: string
): string {
  return path.join(sessionDir(option, stamp), FILES, mirrored(remotePath));
}

async function readManifest(
  option: RemoteBackupOption,
  stamp: string
): Promise<Array<{ p: string; a?: boolean }>> {
  let text: string;
  try {
    text = await fse.readFile(path.join(sessionDir(option, stamp), MANIFEST), 'utf8');
  } catch (error) {
    return [];
  }

  const entries: Array<{ p: string; a?: boolean }> = [];
  text.split('\n').forEach(line => {
    if (line.trim() === '') {
      return;
    }
    try {
      const one = JSON.parse(line);
      if (one && typeof one.p === 'string') {
        entries.push(one);
      }
    } catch (error) {
      // A half-written last line, from a window that went away mid-write.
      // The rest of the session is still good.
    }
  });

  return entries;
}

async function note(
  option: RemoteBackupOption,
  stamp: string,
  entry: { p: string; a?: boolean }
): Promise<void> {
  await fse.ensureDir(sessionDir(option, stamp));
  await fse.appendFile(
    path.join(sessionDir(option, stamp), MANIFEST),
    `${JSON.stringify(entry)}\n`
  );
}

export type Fetched =
  | { kind: 'bytes'; bytes: Buffer }
  | { kind: 'absent' }
  | { kind: 'failed'; error: Error };

/**
 * Keeps what the server has, unless this session already has it.
 *
 * The three answers are not interchangeable, and the caller must act on them:
 * `kept` and `absent` mean the upload may proceed, `failed` means it may not.
 * A transport error while probing is exactly the case where an overwrite would
 * destroy the only copy, so the file is left alone and tried again later.
 */
export async function keepRemote(
  option: RemoteBackupOption,
  stamp: string,
  remotePath: string,
  fetch: () => Promise<Fetched>
): Promise<'kept' | 'absent' | 'failed'> {
  const fetched = await fetch();

  if (fetched.kind === 'failed') {
    return 'failed';
  }

  if (fetched.kind === 'absent') {
    await note(option, stamp, { p: remotePath, a: true });
    return 'absent';
  }

  const where = storedAt(option, stamp, remotePath);
  await fse.ensureDir(path.dirname(where));
  await fse.writeFile(where, fetched.bytes);
  await note(option, stamp, { p: remotePath });

  return 'kept';
}

/** Every session kept for this connection, newest first. */
export async function sessionsOf(option: RemoteBackupOption): Promise<Session[]> {
  let stamps: string[];
  try {
    stamps = await fse.readdir(path.join(option.root, option.connectionId));
  } catch (error) {
    return [];
  }

  const sessions: Session[] = [];
  for (const stamp of stamps) {
    const when = whenOf(stamp);
    if (isNaN(when)) {
      continue;
    }

    sessions.push({ stamp, when, files: (await readManifest(option, stamp)).length });
  }

  return sessions.sort((a, b) => b.when - a.when);
}

/**
 * What to put back to undo everything from `stamp` onwards.
 *
 * The earliest snapshot of each file at or after that moment: the state it was
 * in before the first thing that touched it in that window.
 */
export async function restorePoints(
  option: RemoteBackupOption,
  stamp: string
): Promise<Snapshot[]> {
  const from = whenOf(stamp);
  const sessions = (await sessionsOf(option))
    .filter(one => one.when >= from)
    .sort((a, b) => a.when - b.when); // oldest first: the first seen wins

  const earliest = new Map<string, Snapshot>();

  for (const session of sessions) {
    for (const entry of await readManifest(option, session.stamp)) {
      if (!earliest.has(entry.p)) {
        earliest.set(entry.p, {
          remotePath: entry.p,
          stamp: session.stamp,
          absent: Boolean(entry.a),
        });
      }
    }
  }

  return Array.from(earliest.values()).sort((a, b) =>
    a.remotePath < b.remotePath ? -1 : 1
  );
}

/**
 * Sweeps sessions past their age.
 *
 * Whole sessions, never single files out of one: a session that has lost half
 * its files is no longer the thing it says it is, and a restore from it would
 * quietly put back less than it claims.
 */
export async function pruneRemoteBackups(
  option: RemoteBackupOption,
  now: number = Date.now()
): Promise<{ removed: string[]; bytesFreed: number }> {
  const removed: string[] = [];
  let bytesFreed = 0;

  const oldest = now - option.maxAgeDays * 24 * 60 * 60 * 1000;

  for (const session of await sessionsOf(option)) {
    if (session.when >= oldest) {
      continue;
    }

    const where = sessionDir(option, session.stamp);
    bytesFreed += await sizeOf(where);

    try {
      await fse.remove(where);
      removed.push(session.stamp);
    } catch (error) {
      // Kept a little longer is not a failure worth reporting.
    }
  }

  return { removed, bytesFreed };
}

async function sizeOf(dir: string): Promise<number> {
  let total = 0;

  let entries: string[];
  try {
    entries = await fse.readdir(dir);
  } catch (error) {
    return 0;
  }

  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const stat = await fse.lstat(full);
      total += stat.isDirectory() ? await sizeOf(full) : stat.size;
    } catch (error) {
      // Gone while we counted.
    }
  }

  return total;
}

/** Everything kept for every connection, for a sweep at startup. */
export async function connectionsWithBackups(root: string): Promise<string[]> {
  try {
    return await fse.readdir(root);
  } catch (error) {
    return [];
  }
}
