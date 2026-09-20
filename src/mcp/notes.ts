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
  /** When it was last written or confirmed. */
  updated: number;
}

export interface NoteStore {
  /** Keyed by remote path. */
  files: { [remotePath: string]: Note };
  /** What the project is, as a whole. */
  overview?: Note;
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
  store: NoteStore
): Promise<void> {
  const file = storePath(cacheRoot, connectionId);
  await fse.ensureDir(path.dirname(file));
  await fse.writeFile(file, JSON.stringify(store, null, 2), 'utf8');
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
  current?: { mtime: number; size: number }
): NoteView {
  const note = store.files[remotePath];
  if (!note) {
    return { state: NoteState.None };
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
  version: { mtime: number; size: number }
): NoteStore {
  return {
    ...store,
    files: {
      ...store.files,
      [remotePath]: {
        summary,
        mtime: version.mtime,
        size: version.size,
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
