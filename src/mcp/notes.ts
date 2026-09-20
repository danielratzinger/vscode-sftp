import * as fse from 'fs-extra';
import * as path from 'path';

/**
 * What each file is for, and what the project is.
 *
 * Orientation is an agent's first problem, not similarity: a tree of eight
 * hundred filenames is weak signal, while the same tree with a line of purpose
 * each lets a model choose what to read without reading anything. Unlike
 * vectors these are text - inspectable, searchable, and obviously wrong when
 * they are wrong.
 */

export interface Note {
  summary: string;
  /** The version this describes; a file that moves on makes it stale. */
  mtime: number;
  size: number;
  /**
   * What that version's bytes hashed to, when they were to hand.
   *
   * The timestamp and the size are what a *listing* gives, which is why the
   * cheap check is built on them - but they answer the wrong question. Every
   * deploy here is an upload, and an upload restamps every file it copies,
   * so a redeploy of unchanged code would mark every description on the
   * server stale at once. The hash is what actually says whether the thing
   * described has changed, and it settles both ways: a file whose bytes are
   * the same keeps its description however often it is uploaded, and one
   * whose bytes differ has moved on however the timestamp reads.
   */
  hash?: string;
  /** When it was last written or confirmed. */
  updated: number;
}

export interface Version {
  mtime: number;
  size: number;
  /** Only where the content was at hand: a listing does not carry one. */
  hash?: string;
}

/**
 * Which connection a note store belongs to, written beside the notes.
 *
 * A store lives in a folder named after the connection's id, and that id is
 * derived - from where the connection points, and from what it is called. So
 * renaming a connection, or changing how the id is derived at all, files its
 * notes under a name nothing looks for again. Cached files can be fetched
 * twice; a note is the only thing here that cannot.
 *
 * The name is deliberately not part of this. It is part of the id, so a
 * rename produces a new folder - and this is exactly what lets the new folder
 * find the old one.
 */
export interface ConnectionIdentity {
  workspace: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
}

export interface NoteStore {
  /** Keyed by remote path. */
  files: { [remotePath: string]: Note };
  /** What the project is, as a whole. */
  overview?: Note;
  /** Whose notes these are, for finding them again. */
  connection?: ConnectionIdentity;
}

export function identityOf(
  workspace: string,
  config: any
): ConnectionIdentity {
  return {
    workspace: workspace || '',
    protocol: (config && config.protocol) || '',
    host: (config && config.host) || '',
    port: (config && config.port) || 0,
    username: (config && config.username) || '',
    remotePath: (config && config.remotePath) || '',
  };
}

export function sameConnection(
  a: ConnectionIdentity | undefined,
  b: ConnectionIdentity | undefined
): boolean {
  if (!a || !b) {
    return false;
  }

  return (
    a.workspace === b.workspace &&
    a.protocol === b.protocol &&
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username &&
    a.remotePath === b.remotePath
  );
}

const EMPTY: NoteStore = { files: {} };

export function storePath(cacheRoot: string, connectionId: string): string {
  return path.join(cacheRoot, connectionId, 'notes.json');
}

export async function load(
  cacheRoot: string,
  connectionId: string
): Promise<NoteStore> {
  try {
    const raw = await fse.readFile(storePath(cacheRoot, connectionId), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && parsed.files ? parsed : { ...EMPTY };
  } catch (error) {
    return { ...EMPTY, files: {} };
  }
}

export async function save(
  cacheRoot: string,
  connectionId: string,
  store: NoteStore,
  connection?: ConnectionIdentity
): Promise<void> {
  const file = storePath(cacheRoot, connectionId);
  await fse.ensureDir(path.dirname(file));
  await fse.writeFile(
    file,
    JSON.stringify(connection ? { ...store, connection } : store, null, 2),
    'utf8'
  );
}

/**
 * The same deployment, whatever it is reached by.
 *
 * A password is in neither the id nor the identity, so changing one moves
 * nothing. A host, a port or an account is in both: change any of them and
 * the notes are filed under an id nothing looks for again. But the notes
 * describe files at a path in a project, and that is what has not changed -
 * the rest is how you get there. A server moves to a new box, an IP becomes a
 * DNS name, an account is renamed: same files, same notes.
 */
function sameDeployment(
  a: ConnectionIdentity | undefined,
  b: ConnectionIdentity | undefined
): boolean {
  return Boolean(
    a && b && a.workspace === b.workspace && a.remotePath === b.remotePath
  );
}

export interface Connection {
  id: string;
  identity: ConnectionIdentity;
}

/**
 * Finds a note store this connection left behind under an id it no longer
 * has, and moves it here.
 *
 * Never from a folder that is somebody's current id: two connections can
 * differ by name alone, and the one that still answers to its folder keeps
 * it. Where the match is on the deployment rather than the whole identity it
 * has to be unambiguous in both directions - one orphan that could be this
 * connection's, and one connection that orphan could belong to - because
 * adopting another project's notes is worse than losing your own. Half of
 * these connections share a workspace and a `/httpdocs`, so that is not a
 * theoretical tie.
 */
export async function adopt(
  cacheRoot: string,
  connectionId: string,
  connection: ConnectionIdentity,
  everyone: Connection[]
): Promise<string | undefined> {
  const here = await load(cacheRoot, connectionId);
  if (Object.keys(here.files).length > 0 || here.overview) {
    return undefined; // Already has notes of its own.
  }

  let folders: string[];
  try {
    folders = await fse.readdir(cacheRoot);
  } catch (error) {
    return undefined;
  }

  const current = everyone.map(one => one.id);
  const orphans: Array<{ folder: string; store: NoteStore }> = [];

  for (const folder of folders) {
    if (folder === connectionId || current.indexOf(folder) !== -1) {
      continue;
    }

    const store = await load(cacheRoot, folder);
    if (Object.keys(store.files).length === 0 && !store.overview) {
      continue;
    }
    if (!store.connection) {
      continue; // Written before stores said whose they were.
    }

    orphans.push({ folder, store });
  }

  const take = async (found: { folder: string; store: NoteStore }) => {
    await save(cacheRoot, connectionId, found.store, connection);
    await fse.remove(storePath(cacheRoot, found.folder));
    return found.folder;
  };

  const exact = orphans.filter(one => sameConnection(one.store.connection, connection));
  if (exact.length > 0) {
    return take(exact[0]);
  }

  const moved = orphans.filter(one => sameDeployment(one.store.connection, connection));
  if (moved.length !== 1) {
    return undefined;
  }

  const claimants = everyone.filter(one =>
    sameDeployment(one.identity, moved[0].store.connection)
  );

  return claimants.length === 1 ? take(moved[0]) : undefined;
}

export const enum NoteState {
  None = 'none',
  Current = 'current',
  Stale = 'stale',
}

export interface NoteView {
  state: NoteState;
  summary?: string;
  /** Set when the note describes an older version. */
  describedMtime?: number;
}

/**
 * A note describes one version of a file. A confidently wrong summary is worse
 * than no summary, so one whose file has moved on is reported as stale and
 * never served as current - but kept, because a small edit rarely changes what
 * a file is *for*, and a stale note is cheap to refresh and a fair starting
 * point.
 */
export function viewOf(
  store: NoteStore,
  remotePath: string,
  current?: Version
): NoteView {
  const note = store.files[remotePath];
  if (!note) {
    return { state: NoteState.None };
  }

  // A hash on both sides settles it outright, in either direction.
  if (current && current.hash && note.hash) {
    return current.hash === note.hash
      ? { state: NoteState.Current, summary: note.summary }
      : {
          state: NoteState.Stale,
          summary: note.summary,
          describedMtime: note.mtime,
        };
  }

  if (
    current &&
    (Math.floor(note.mtime / 1000) !== Math.floor(current.mtime / 1000) ||
      note.size !== current.size)
  ) {
    return {
      state: NoteState.Stale,
      summary: note.summary,
      describedMtime: note.mtime,
    };
  }

  return { state: NoteState.Current, summary: note.summary };
}

export function put(
  store: NoteStore,
  remotePath: string,
  summary: string,
  version: Version
): NoteStore {
  return {
    ...store,
    files: {
      ...store.files,
      [remotePath]: {
        summary,
        mtime: version.mtime,
        size: version.size,
        hash: version.hash,
        updated: Date.now(),
      },
    },
  };
}

/**
 * The same description, against the version in front of us now.
 *
 * Not a new description - the words are untouched. This is for the case where
 * the bytes are known to be the ones the note was written about, and only the
 * timestamp has moved: a redeploy, a touch, a transfer that rewrote the file
 * with what was already in it. Re-anchoring is also a confirmation, so it
 * counts against ageing out.
 */
export function reanchor(
  store: NoteStore,
  remotePath: string,
  version: Version
): NoteStore {
  const note = store.files[remotePath];
  if (!note) {
    return store;
  }

  return {
    ...store,
    files: {
      ...store.files,
      [remotePath]: {
        ...note,
        mtime: version.mtime,
        size: version.size,
        hash: version.hash || note.hash,
        updated: Date.now(),
      },
    },
  };
}

/**
 * What the project is, as opposed to what one of its files is.
 *
 * `overview` reads a name and a framework out of `composer.json` and friends,
 * which is honest but thin, and on a project with neither it says nothing at
 * all. What a server is *for* - the pipeline it runs, what talks to it, what
 * is deployed where - is learned by reading it, and until now there was
 * nowhere to put that. The field was in this type from the first version and
 * nothing ever wrote it.
 *
 * No version to key it to, since it describes no single file, so it goes
 * stale by age alone.
 */
export function putOverview(store: NoteStore, summary: string): NoteStore {
  return {
    ...store,
    overview: { summary, mtime: 0, size: 0, updated: Date.now() },
  };
}

export interface OverviewView {
  summary: string;
  updated: number;
  /** True once nobody has confirmed it for `maxAge`. */
  stale: boolean;
}

export function overviewOf(
  store: NoteStore,
  maxAge: number,
  now: number = Date.now()
): OverviewView | undefined {
  if (!store.overview) {
    return undefined;
  }

  return {
    summary: store.overview.summary,
    updated: store.overview.updated,
    stale: now - store.overview.updated > maxAge,
  };
}

export function forget(store: NoteStore, remotePath?: string): NoteStore {
  if (remotePath === undefined) {
    return { files: {} };
  }

  const files = { ...store.files };
  delete files[remotePath];
  return { ...store, files };
}

export interface PruneOption {
  /** Paths the server still has. Anything else describes nothing. */
  present: (remotePath: string) => boolean;
  /** Drop a note that has been wrong for longer than this. */
  maxStaleAge: number;
  /** Cap on how many notes to keep, least recently updated evicted first. */
  maxNotes: number;
  now?: number;
}

export interface PruneResult {
  store: NoteStore;
  removed: string[];
  reasons: { [remotePath: string]: string };
}

/**
 * Notes are pruned on the same discipline as cache entries, with one deliberate
 * difference: a transfer does not purge them. A cache entry records a
 * disagreement and is meaningless once the copies agree; a note records
 * understanding, which downloading a file does not invalidate. Only a content
 * change does, and the key already captures that.
 */
export function prune(store: NoteStore, option: PruneOption): PruneResult {
  const now = option.now || Date.now();
  const removed: string[] = [];
  const reasons: { [remotePath: string]: string } = {};
  const files: { [remotePath: string]: Note } = {};

  Object.keys(store.files).forEach(remotePath => {
    const note = store.files[remotePath];

    if (!option.present(remotePath)) {
      removed.push(remotePath);
      reasons[remotePath] = 'the server no longer has it';
      return;
    }

    if (now - note.updated > option.maxStaleAge) {
      removed.push(remotePath);
      reasons[remotePath] = 'it has been unconfirmed for too long';
      return;
    }

    files[remotePath] = note;
  });

  const kept = Object.keys(files);
  if (kept.length > option.maxNotes) {
    // Least recently updated first: the ones least likely to still be right.
    kept
      .sort((a, b) => files[a].updated - files[b].updated)
      .slice(0, kept.length - option.maxNotes)
      .forEach(remotePath => {
        delete files[remotePath];
        removed.push(remotePath);
        reasons[remotePath] = 'the store is full';
      });
  }

  return { store: { ...store, files }, removed, reasons };
}

/**
 * What can be worked out about a project without asking a model anything.
 *
 * Cheap, always available, and incapable of hallucinating - which is why it
 * comes first and any narrative sits on top of it, labelled as derived.
 */
export interface Facts {
  [label: string]: string;
}

export function factsFrom(files: {
  [remotePath: string]: string;
}): Facts {
  const facts: Facts = {};

  Object.keys(files).forEach(remotePath => {
    const name = remotePath.split('/').pop() || '';
    const content = files[remotePath];

    if (name === 'composer.json' || name === 'package.json') {
      readJsonFacts(content, facts, name === 'package.json' ? 'npm' : 'composer');
    }
    if (name === 'style.css') {
      readThemeHeader(content, facts);
    }
    if (/^readme(\.md|\.txt)?$/i.test(name) && !facts.readme) {
      const heading = /^#\s*(.+)$/m.exec(content);
      if (heading) {
        facts.readme = heading[1].trim();
      }
    }
  });

  return facts;
}

function readJsonFacts(content: string, facts: Facts, kind: string) {
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return;
  }

  if (parsed.name) {
    facts[`${kind} name`] = String(parsed.name);
  }
  if (parsed.description) {
    facts[`${kind} description`] = String(parsed.description);
  }

  const dependencies = Object.keys(parsed.dependencies || {});
  const framework = dependencies.find(name =>
    /laravel|symfony|typo3|craft|wordpress|next|nuxt|react|vue|svelte|express/i.test(
      name
    )
  );
  if (framework) {
    facts.framework = `${framework} ${parsed.dependencies[framework]}`;
  }
}

function readThemeHeader(content: string, facts: Facts) {
  const theme = /Theme Name:\s*(.+)/i.exec(content);
  const author = /Author:\s*(.+)/i.exec(content);

  if (theme) {
    facts['wordpress theme'] = theme[1].trim();
  }
  if (author) {
    facts['theme author'] = author[1].trim();
  }
}
