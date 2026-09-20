import * as fse from 'fs-extra';
import * as path from 'path';

/**
 * Where a file's bytes come from, and where they are allowed to land.
 *
 * The invariant: **the MCP server never changes a file you already have.** Only
 * an absent file is materialised into the project. Anything that differs - in
 * either direction - goes to a cache of its own and the divergence is reported,
 * because silently rewriting a file in someone's working tree as a side effect
 * of a question is not a thing a read-only tool should do.
 */
export const enum LocalState {
  Missing = 'missing',
  Same = 'same',
  /** The server's copy is newer. */
  Older = 'older',
  /** Ours is newer: unsaved work the server has never seen. */
  Newer = 'newer',
}

export interface RemoteStat {
  size: number;
  mtime: number;
}

export interface Resolution {
  state: LocalState;
  /** Where the content this server serves is kept. */
  source: 'workspace' | 'cache';
  localPath: string;
  cachePath: string;
  localMtime?: number;
  remoteMtime: number;
}

export interface CacheOption {
  /** Root of the cache, under the extension's global storage. */
  cacheRoot: string;
  /** False keeps the server out of the project directory entirely. */
  materialize?: boolean;
}

/** Seconds, like the sync algorithm: many servers report nothing finer. */
function toSeconds(mtime: number): number {
  return Math.floor(mtime / 1000);
}

export function compare(
  local: { size: number; mtime: number } | undefined,
  remote: RemoteStat
): LocalState {
  if (!local) {
    return LocalState.Missing;
  }

  const here = toSeconds(local.mtime);
  const there = toSeconds(remote.mtime);

  if (here === there) {
    // Same second but a different size means somebody edited it just after it
    // was written; treat that as ours being ahead.
    return local.size === remote.size ? LocalState.Same : LocalState.Newer;
  }

  return here > there ? LocalState.Newer : LocalState.Older;
}

/**
 * The cache mirrors the remote path under a per-connection directory, so a
 * path collision between two servers is impossible and the layout is legible
 * when you go looking.
 */
export function cachePathFor(
  option: CacheOption,
  connectionId: string,
  remotePath: string
): string {
  const relative = remotePath.replace(/^[\\/]+/, '').replace(/\\/g, '/');
  // `..` is dropped rather than resolved. The tools refuse such a path long
  // before this, but this is the last step before a write, and a cache entry
  // that lands outside its connection's directory is worth being sure about.
  const parts = relative
    .split('/')
    .filter(part => part !== '' && part !== '.' && part !== '..');

  return path.join(option.cacheRoot, connectionId, ...parts);
}

async function statOrUndefined(file: string) {
  try {
    const stat = await fse.stat(file);
    return { size: stat.size, mtime: stat.mtime.getTime() };
  } catch (error) {
    return undefined;
  }
}

export interface ResolveInput {
  connectionId: string;
  remotePath: string;
  localPath: string;
  remote: RemoteStat;
  option: CacheOption;
}

export async function resolve(input: ResolveInput): Promise<Resolution> {
  const local = await statOrUndefined(input.localPath);
  const state = compare(local, input.remote);
  const cachePath = cachePathFor(
    input.option,
    input.connectionId,
    input.remotePath
  );

  // Missing and identical are the only two cases where writing the project
  // directory cannot destroy anything: there is nothing there, or what is
  // there already matches.
  const canMaterialize =
    input.option.materialize !== false &&
    (state === LocalState.Missing || state === LocalState.Same);

  return {
    state,
    source: canMaterialize ? 'workspace' : 'cache',
    localPath: input.localPath,
    cachePath,
    localMtime: local ? local.mtime : undefined,
    remoteMtime: input.remote.mtime,
  };
}

export interface Materialised extends Resolution {
  /** Where the bytes actually are, after any write. */
  contentPath: string;
  /** True when this call wrote the file rather than finding it already there. */
  written: boolean;
}

export interface Writer {
  /** Fetches the remote file's bytes. */
  read(remotePath: string): Promise<Buffer>;
  /** Called with a path just written into the project, to quiet the watcher. */
  onWorkspaceWrite?(localPath: string): void;
}

/**
 * One file at a time, per file.
 *
 * Clients issue tool calls in parallel, and two of them wanting the same file -
 * a search and a fetch, say - would otherwise write it twice while reading it
 * once. The reader can see a half-written file: not a crash, just a truncated
 * answer nobody can explain afterwards. Queueing also means the second caller
 * re-resolves and finds the file already correct, so it costs one round trip
 * instead of two.
 */
const inFlight: { [key: string]: Promise<void> } = {};

function queue<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = inFlight[key] || Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.then(() => undefined, () => undefined);

  inFlight[key] = settled;
  settled.then(() => {
    // Only if nothing else joined the queue behind us.
    if (inFlight[key] === settled) {
      delete inFlight[key];
    }
  });

  return next;
}

/**
 * Puts the server's copy of a file where it belongs and says where that is.
 */
export function materialise(
  input: ResolveInput,
  writer: Writer
): Promise<Materialised> {
  return queue(`${input.connectionId}:${input.remotePath}`, () =>
    materialiseNow(input, writer)
  );
}

async function materialiseNow(
  input: ResolveInput,
  writer: Writer
): Promise<Materialised> {
  const resolution = await resolve(input);

  if (resolution.source === 'workspace' && resolution.state === LocalState.Same) {
    // Already correct; touching it would only confuse the watcher.
    return { ...resolution, contentPath: resolution.localPath, written: false };
  }

  const target =
    resolution.source === 'workspace'
      ? resolution.localPath
      : resolution.cachePath;

  if (resolution.source === 'cache') {
    const cached = await statOrUndefined(target);
    // A cache entry is keyed by the version it was fetched at; a file that has
    // moved on since is re-fetched rather than served stale.
    if (cached && toSeconds(cached.mtime) === toSeconds(input.remote.mtime)) {
      return { ...resolution, contentPath: target, written: false };
    }
  }

  const bytes = await writer.read(input.remotePath);
  await fse.ensureDir(path.dirname(target));
  await fse.writeFile(target, bytes);
  // Carry the server's timestamp, so the next comparison reads "same" rather
  // than "ours is newer because we just wrote it".
  await fse.utimes(target, input.remote.mtime / 1000, input.remote.mtime / 1000);

  if (resolution.source === 'workspace' && writer.onWorkspaceWrite) {
    writer.onWorkspaceWrite(target);
  }

  return { ...resolution, contentPath: target, written: true };
}

/**
 * The remote path a cached file stands for: the inverse of `cachePathFor`.
 */
function remotePathOf(root: string, file: string): string {
  return `/${path.relative(root, file).split(path.sep).join('/')}`;
}

/**
 * Sweeps a connection's cache, keeping only what `keep` says to.
 *
 * Notes are pruned on a complete tree walk; this is the same sweep for the
 * bytes, so a cache does not accumulate copies of files the server deleted
 * months ago. Deleting one costs nothing but a re-fetch, which is why the
 * predicate can afford to be simple.
 */
export async function pruneCache(
  option: CacheOption,
  connectionId: string,
  keep: (remotePath: string) => boolean
): Promise<string[]> {
  const root = path.join(option.cacheRoot, connectionId);
  const removed: string[] = [];

  async function sweep(dir: string): Promise<number> {
    let kept = 0;
    let entries: string[];
    try {
      entries = await fse.readdir(dir);
    } catch (error) {
      return 0;
    }

    for (const name of entries) {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = await fse.stat(full);
      } catch (error) {
        continue;
      }

      if (stat.isDirectory()) {
        kept += await sweep(full);
        continue;
      }

      if (keep(remotePathOf(root, full))) {
        kept += 1;
        continue;
      }

      try {
        await fse.unlink(full);
        removed.push(remotePathOf(root, full));
      } catch (error) {
        kept += 1;
      }
    }

    if (kept === 0 && dir !== root) {
      // An empty directory left behind is just litter.
      try {
        await fse.rmdir(dir);
      } catch (error) {
        // Something arrived while we were looking; leave it.
      }
    }

    return kept;
  }

  await sweep(root);

  return removed;
}

/** Removes cached copies for paths the server no longer has. */
export async function pruneMissing(
  option: CacheOption,
  connectionId: string,
  keep: (remotePath: string) => boolean,
  known: string[]
): Promise<string[]> {
  const removed: string[] = [];

  for (const remotePath of known) {
    if (keep(remotePath)) {
      continue;
    }

    const file = cachePathFor(option, connectionId, remotePath);
    try {
      await fse.unlink(file);
      removed.push(remotePath);
    } catch (error) {
      // Already gone.
    }
  }

  return removed;
}

/**
 * Removes cache folders from the scheme this one replaced.
 *
 * Connections used to be filed under the number the editor gave them, which
 * meant a different server after every reload; they are filed under a stable
 * id now. The folders left behind hold copies of real projects' files that
 * nothing will ever read again or sweep, so they go - and only ever a folder
 * named like one of those numbers, never one that is a live connection's id.
 */
export async function pruneOldConnectionFolders(
  cacheRoot: string,
  currentIds: string[]
): Promise<string[]> {
  const removed: string[] = [];

  let entries: string[];
  try {
    entries = await fse.readdir(cacheRoot);
  } catch (error) {
    return removed; // Nothing cached yet.
  }

  for (const name of entries) {
    // A stable id is eight hex characters; the old ones counted from 1. An id
    // that happens to be all digits is spared by being a live connection's.
    if (!/^[0-9]{1,7}$/.test(name) || currentIds.indexOf(name) !== -1) {
      continue;
    }

    try {
      const full = path.join(cacheRoot, name);
      if ((await fse.stat(full)).isDirectory()) {
        await fse.remove(full);
        removed.push(name);
      }
    } catch (error) {
      // Gone, or not ours to remove.
    }
  }

  return removed;
}
