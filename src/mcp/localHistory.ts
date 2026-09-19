import * as fse from 'fs-extra';
import * as path from 'path';

/**
 * The editor's own record of what a file used to be.
 *
 * VS Code keeps a local history of every save, which is the one thing here
 * that knows what a file looked like before the change being asked about. It
 * is not served by anything else: the server has one version, the working copy
 * has another, and everything in between only exists here.
 *
 * There is no API for reading it - the Timeline is a provider interface, not a
 * reader - so this reads the store on disk. That store is VS Code's, so it is
 * only ever read, never written, and every assumption about its shape is
 * checked before it is used: a version field, a resource that matches what was
 * asked for, and a fallback that works even if the naming scheme changes.
 */

export interface Version {
  /** The file holding the content, inside `folder`. */
  id: string;
  timestamp: number;
  /** What made the entry, when VS Code recorded one. */
  source?: string;
  folder: string;
}

interface EntriesFile {
  version: number;
  resource: string;
  entries: Array<{ id: string; timestamp: number; source?: string }>;
}

/**
 * `<user data>/User/globalStorage/<extension>` sits two levels below `User`,
 * which is also where `History` lives. Deriving it this way rather than
 * guessing a path per platform means Insiders, VSCodium and a portable install
 * are all found without knowing about them.
 */
export function historyRootFrom(globalStoragePath: string): string {
  return path.resolve(globalStoragePath, '..', '..', 'History');
}

/**
 * VS Code names each folder after a hash of the resource URI. Reproducing it
 * turns a lookup into one read instead of a scan of every file ever edited.
 *
 * Copied from `vs/base/common/hash`, and verified against a real store rather
 * than trusted: see the test.
 */
function numberHash(value: number, initial: number): number {
  // tslint:disable-next-line:no-bitwise
  return (((initial << 5) - initial) + value) | 0;
}

export function stringHash(text: string): number {
  let value = numberHash(149417, 0);
  for (let i = 0; i < text.length; i += 1) {
    value = numberHash(text.charCodeAt(i), value);
  }

  return value;
}

export function folderNameFor(uri: string): string {
  return stringHash(uri).toString(16);
}

async function readEntries(
  root: string,
  folder: string
): Promise<EntriesFile | undefined> {
  try {
    const raw = await fse.readFile(path.join(root, folder, 'entries.json'), 'utf8');
    const parsed = JSON.parse(raw);

    // Anything else is a format we have not seen and will not guess at.
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return undefined;
    }

    return parsed;
  } catch (error) {
    return undefined;
  }
}

/** folder name by resource, rebuilt at most this often. */
const INDEX_TTL = 60 * 1000;
let index: { at: number; byResource: { [uri: string]: string } } | null = null;

async function scanForResource(
  root: string,
  uri: string,
  now: number
): Promise<string | undefined> {
  if (!index || now - index.at > INDEX_TTL) {
    const byResource: { [key: string]: string } = {};

    let folders: string[];
    try {
      folders = await fse.readdir(root);
    } catch (error) {
      return undefined;
    }

    for (const folder of folders) {
      const entries = await readEntries(root, folder);
      if (entries && typeof entries.resource === 'string') {
        byResource[entries.resource] = folder;
      }
    }

    index = { at: now, byResource };
  }

  return index.byResource[uri];
}

/** Drops the scan index, so a test or a changed store starts again. */
export function forgetIndex(): void {
  index = null;
}

/**
 * Every version of a file the editor still holds, newest first.
 */
export async function versionsFor(
  root: string,
  uri: string,
  now: number = Date.now()
): Promise<Version[]> {
  const guess = folderNameFor(uri);
  let folder: string | undefined = guess;
  let entries = await readEntries(root, guess);

  // The name is a guess at somebody else's scheme; the resource inside is the
  // proof. If it does not match, find it the slow, certain way.
  if (!entries || entries.resource !== uri) {
    folder = await scanForResource(root, uri, now);
    entries = folder ? await readEntries(root, folder) : undefined;
  }

  if (!entries || !folder || entries.resource !== uri) {
    return [];
  }

  const held = folder;

  return entries.entries
    .filter(entry => entry && typeof entry.id === 'string')
    .map(entry => ({
      id: entry.id,
      timestamp: entry.timestamp,
      source: entry.source,
      folder: held,
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

export async function contentOf(
  root: string,
  version: Version
): Promise<string | undefined> {
  try {
    return await fse.readFile(path.join(root, version.folder, version.id), 'utf8');
  } catch (error) {
    return undefined;
  }
}

/** How long ago, in words a model can use without doing arithmetic. */
export function describeAge(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));

  if (seconds < 90) {
    return 'just now';
  }
  if (seconds < 60 * 60) {
    return `${Math.round(seconds / 60)} minutes ago`;
  }
  if (seconds < 36 * 60 * 60) {
    return `${Math.round(seconds / 3600)} hours ago`;
  }

  return `${Math.round(seconds / 86400)} days ago`;
}
