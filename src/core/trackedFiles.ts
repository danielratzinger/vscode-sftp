import * as path from 'path';
import * as fse from 'fs-extra';
import { execFile } from 'child_process';
import { gitDirOf } from './worktrees';

/**
 * Which files git is keeping, and noticing when that changes.
 *
 * A watcher sees a file disappear, but "disappeared" and "deleted from the
 * project" are not the same event: a build clears `dist`, an editor swaps a
 * file out and back, a branch switch rewrites half the tree. Reacting to every
 * one of those by removing something from a live server is not what anybody
 * means by keeping a deployment in step.
 *
 * What they mean is: this file is no longer part of the project. Git knows
 * that exactly - it is the index - so that is what is watched. A file that
 * leaves `git ls-files` has been removed from the branch, and a branch switch
 * that removes it is still a removal as far as what should be deployed goes.
 *
 * Read only when the index has actually been written, which is one `lstat` to
 * find out and nothing at all the rest of the time.
 */

/** When git last wrote the index, or undefined if there is no index to read. */
export async function indexWrittenAt(root: string): Promise<number | undefined> {
  const gitDir = await gitDirOf(root);
  if (!gitDir) {
    return undefined;
  }

  // A linked worktree has its own index, beside its own HEAD, not the shared
  // one - which is the whole point of a worktree.
  for (const candidate of [await ownGitDirOf(root), gitDir]) {
    if (!candidate) {
      continue;
    }

    try {
      return (await fse.lstat(path.join(candidate, 'index'))).mtimeMs;
    } catch (error) {
      // Try the next one.
    }
  }

  return undefined;
}

/** A linked checkout's own `.git/worktrees/<name>` directory, if it is one. */
async function ownGitDirOf(root: string): Promise<string | undefined> {
  try {
    const pointer = await fse.readFile(path.join(root, '.git'), 'utf8');
    const linked = pointer.split('\n')[0].trim().replace(/^gitdir:\s*/, '');
    return linked || undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Every file git is tracking in this checkout, as absolute paths.
 *
 * `undefined` rather than an empty list when git cannot answer, because
 * "nothing is tracked" and "there is no git here" lead to opposite actions:
 * the first would mean deleting the whole deployment.
 */
export function trackedIn(root: string): Promise<Set<string> | undefined> {
  return new Promise(resolve => {
    execFile(
      'git',
      ['ls-files', '-z'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }

        const tracked = new Set<string>();
        stdout.split('\0').forEach(one => {
          if (one !== '') {
            tracked.add(path.join(root, one));
          }
        });

        resolve(tracked);
      }
    );
  });
}

/** What was tracked and is not any more. */
export function vanished(before: Set<string>, after: Set<string>): string[] {
  const gone: string[] = [];

  before.forEach(file => {
    if (!after.has(file)) {
      gone.push(file);
    }
  });

  return gone.sort();
}
