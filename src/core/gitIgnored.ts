import * as path from 'path';
import { execFile } from 'child_process';

/**
 * Whether git would ignore a file - asked of git, not guessed at.
 *
 * Upload-on-save never needed this: you only save files you opened, and you do
 * not open `node_modules`. A watcher is different. It sees every write by
 * every process, so `npm install` in a watched checkout is forty thousand
 * files heading for the server unless something stops them, and most
 * `sftp.json` files here have no `ignore` list at all.
 *
 * The rule is git's: a file is deployable if git tracks it, or if nothing in
 * the `.gitignore` chain rejects it. `git check-ignore` answers exactly that -
 * it consults the index, so a tracked file is never reported ignored - which
 * is why this asks git rather than reimplementing pattern semantics that took
 * git twenty years to settle.
 *
 * What it costs is a process, so it is asked as few times as possible: once
 * for a whole batch of files rather than once each, and once per directory
 * rather than once per file under it. Forty thousand files arriving in one
 * `npm install` are one question when `node_modules` is ignored, and one
 * question per batch when it is not. Asked one at a time it was eleven
 * milliseconds a file, which is four minutes of git for one install.
 *
 * The edge it gives up: a file force-added inside an ignored directory is
 * treated as ignored, because its directory is. Git says the same when asked
 * about the directory, and the alternative is a process per file forever.
 */

export interface IgnoreLookup {
  /** Which of these absolute paths should be left where they are. */
  ignoredAmong(files: string[]): Promise<Set<string>>;
  /** Whether this one should. Convenience; the batch is the real question. */
  ignored(file: string): Promise<boolean>;
  /** Forget what was asked - after a `.gitignore` is written, say. */
  forget(): void;
}

/** Asks git about several paths at once; returns the ones it ignores. */
export type AskGit = (paths: string[]) => Promise<string[] | undefined>;

export function viaGit(root: string): AskGit {
  return (paths: string[]) =>
    new Promise(resolve => {
      const child = execFile(
        'git',
        ['check-ignore', '-z', '--stdin'],
        { cwd: root, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout) => {
          // Exit 1 means "none of them", which is not a failure. Anything
          // else - no git, not a repository - is, and undefined says so.
          if (error && (error as any).code !== 1) {
            resolve(undefined);
            return;
          }

          resolve(stdout.split('\0').filter(one => one !== ''));
        }
      );

      // NUL in, NUL out: `-z` governs both, and a path may hold anything
      // except NUL.
      child.stdin!.end(paths.map(one => `${one}\0`).join(''));
    });
}

/** A path that is not inside the root at all. `.env` is; `../x` is not. */
export function outside(relative: string): boolean {
  return (
    relative === '' ||
    relative === '..' ||
    relative.indexOf(`..${path.sep}`) === 0 ||
    path.isAbsolute(relative)
  );
}

/**
 * The directories between the root and a file, outermost first.
 *
 * The root itself is not among them: a repository is not ignored by its own
 * rules, and asking would only ever be wrong.
 */
export function ancestorsOf(root: string, file: string): string[] {
  const relative = path.relative(root, file);
  if (outside(relative)) {
    return [];
  }

  const parts = relative.split(path.sep);
  parts.pop(); // the file itself

  return parts.map((part, index) => parts.slice(0, index + 1).join(path.sep));
}

export function gitIgnoreIn(root: string, ask: AskGit = viaGit(root)): IgnoreLookup {
  let known = new Map<string, boolean>();
  let workable = true;

  /** A directory above this one that is already known to be ignored. */
  function rejectedAbove(chain: string[]): boolean {
    return chain.some(one => known.get(one) === true);
  }

  async function ignoredAmong(files: string[]): Promise<Set<string>> {
    const ignored = new Set<string>();
    if (!workable || files.length === 0) {
      return ignored;
    }

    const asking: string[] = [];
    const undecided: Array<{ file: string; relative: string; chain: string[] }> = [];

    for (const file of files) {
      const relative = path.relative(root, file);
      if (outside(relative)) {
        continue; // Not inside the checkout. Not this lookup's to judge.
      }

      const chain = ancestorsOf(root, file);
      if (rejectedAbove(chain)) {
        ignored.add(file);
        continue;
      }

      undecided.push({ file, relative, chain });
      chain.concat(relative).forEach(one => {
        if (!known.has(one)) {
          asking.push(one);
        }
      });
    }

    if (asking.length > 0) {
      // One question for the whole batch, and one entry per path in it however
      // many files share a directory.
      const unique = Array.from(new Set(asking));
      const answer = await ask(unique);

      if (answer === undefined) {
        // No git here. Nothing is ignored, and nothing will be asked again.
        workable = false;
        return new Set();
      }

      const rejected = new Set(answer);
      unique.forEach(one => known.set(one, rejected.has(one)));
    }

    undecided.forEach(({ file, relative, chain }) => {
      if (rejectedAbove(chain) || known.get(relative) === true) {
        ignored.add(file);
      }
    });

    return ignored;
  }

  return {
    ignoredAmong,

    async ignored(file: string): Promise<boolean> {
      return (await ignoredAmong([file])).has(file);
    },

    forget(): void {
      known = new Map();
      workable = true;
    },
  };
}
