import * as path from 'path';
import * as fse from 'fs-extra';
import { gitDirOf, Worktree, worktreesOf } from './worktrees';

/**
 * Other checkouts of the same repository, wherever they are on this machine.
 *
 * Agent tooling does not always add a worktree; some of it clones. A clone is
 * not related to yours as far as git is concerned - separate `.git`, separate
 * everything - so the worktree metadata that finds a checkout of *your* repo
 * finds nothing at all. What relates them is the remote they came from.
 *
 * Matched on the origin URL, normalised, because the same repository is
 * written a dozen ways: `https://github.com/x/y.git`, `git@github.com:x/y`,
 * with or without the suffix, with or without credentials in front.
 *
 * Searched rather than known, so it is bounded on every axis - how deep, how
 * many directories, and which roots to start from - and only ever run when
 * somebody opens the list.
 */

const SKIP = [
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.cache',
  'Library',
  'Applications',
];

/** How far below a search root a checkout can be and still be found. */
const DEPTH = 3;

/** A ceiling, so a search root somebody points at `/` cannot run away. */
const MOST_DIRECTORIES = 4000;

/** `https://github.com/x/y.git` and `git@github.com:x/y` are the same repo. */
export function sameRemote(a?: string, b?: string): boolean {
  return Boolean(a && b && normaliseRemote(a) === normaliseRemote(b));
}

export function normaliseRemote(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:/g, '/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/**
 * The origin of a checkout, read from the config git keeps it in.
 *
 * `.git/config` rather than `git remote -v`: it is the same information
 * without a process per candidate, and a search looks at a lot of candidates.
 */
export async function originOf(gitDir: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await fse.readFile(path.join(gitDir, 'config'), 'utf8');
  } catch (error) {
    return undefined;
  }

  const lines = text.split('\n');
  let inOrigin = false;

  for (const line of lines) {
    const section = line.match(/^\s*\[(.+?)\]\s*$/);
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1].trim());
      continue;
    }

    if (!inOrigin) {
      continue;
    }

    const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (url) {
      return url[1];
    }
  }

  return undefined;
}

/**
 * When something in here was last written.
 *
 * The question is which checkout somebody is working in, and the honest answer
 * is the newest file in it - but a full walk of a large project to sort a list
 * is not a trade worth making. So: bounded, shallow-first, and skipping what
 * is never edited by hand. It is an indication, and the list says so by
 * showing the time rather than only the order.
 */
export async function lastEditIn(
  root: string,
  budget = 1500
): Promise<number | undefined> {
  let newest: number | undefined;
  let seen = 0;

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (seen >= budget || depth > DEPTH) {
      return;
    }

    let entries: string[];
    try {
      entries = await fse.readdir(dir);
    } catch (error) {
      return;
    }

    const below: string[] = [];

    for (const name of entries) {
      if (seen >= budget) {
        return;
      }
      if (name === '.git' || SKIP.indexOf(name) !== -1) {
        continue;
      }

      const full = path.join(dir, name);
      let stat;
      try {
        stat = await fse.lstat(full);
      } catch (error) {
        continue;
      }

      seen += 1;

      if (stat.isDirectory()) {
        below.push(full);
        continue;
      }

      if (newest === undefined || stat.mtimeMs > newest) {
        newest = stat.mtimeMs;
      }
    }

    for (const dirBelow of below) {
      await visit(dirBelow, depth + 1);
    }
  };

  await visit(root, 0);

  return newest;
}

/** Every checkout under `roots` whose origin is the same as `origin`. */
export async function clonesOf(
  origin: string,
  roots: string[],
  exclude: string[] = []
): Promise<string[]> {
  const found: string[] = [];
  const excluded = exclude.map(one => path.resolve(one));
  let looked = 0;

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (looked >= MOST_DIRECTORIES || depth > DEPTH) {
      return;
    }

    let entries: string[];
    try {
      entries = await fse.readdir(dir);
    } catch (error) {
      return;
    }

    looked += 1;

    // A checkout is not searched through: its own worktrees are found from its
    // metadata, and its files are not other repositories.
    if (entries.indexOf('.git') !== -1) {
      const gitDir = await gitDirOf(dir);
      const here = path.resolve(dir);

      if (
        gitDir &&
        excluded.indexOf(here) === -1 &&
        sameRemote(await originOf(gitDir), origin)
      ) {
        found.push(here);
      }

      return;
    }

    for (const name of entries) {
      if (name.charAt(0) === '.' || SKIP.indexOf(name) !== -1) {
        continue;
      }

      const full = path.join(dir, name);
      try {
        if ((await fse.lstat(full)).isDirectory()) {
          await visit(full, depth + 1);
        }
      } catch (error) {
        // Gone, or not ours to read.
      }
    }
  };

  for (const root of roots) {
    await visit(path.resolve(root), 0);
  }

  return found;
}

/** Two paths that are the same place. */
function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * Every checkout of the repository containing `root`: its own worktrees, and
 * the worktrees of every clone of it found under `searchIn`.
 *
 * The two halves are not equally certain, and the difference matters. The
 * worktrees are read from git's metadata and are exact. The clones are
 * searched for, so they are as good as the roots they were given - which is
 * why the search is somewhere a person can add to rather than a guess made
 * here.
 *
 * Empty when `root` is not in a repository at all. What to do about that is
 * the caller's: a connection has a folder to offer either way, and this
 * module knows about git and not about connections.
 */
export async function checkoutsOf(
  root: string,
  searchIn: string[]
): Promise<Worktree[]> {
  const mine = await worktreesOf(root);
  if (mine.length === 0) {
    return [];
  }

  const gitDir = await gitDirOf(root);
  const origin = gitDir ? await originOf(gitDir) : undefined;
  if (!origin) {
    return mine;
  }

  const found = [...mine];
  const clones = await clonesOf(origin, searchIn, mine.map(one => one.root));

  for (const clone of clones) {
    for (const checkout of await worktreesOf(clone)) {
      // Another clone's own folder is its main worktree, not this window's.
      if (found.every(one => !samePath(one.root, checkout.root))) {
        found.push({ ...checkout, isMain: false });
      }
    }
  }

  return found;
}
