import * as path from 'path';
import { execFile } from 'child_process';

/**
 * What git was keeping when the editor last looked, in one line.
 *
 * Autosync takes a file off the server when it leaves git's index - but only
 * while it is watching. A file removed while the editor was closed left the
 * index with nobody there to see it, and stayed on the server.
 *
 * Keeping the list of every tracked file to compare against would be forty
 * thousand paths written down on every commit. Git already has a way to name a
 * whole index in one hash: `git write-tree` stores it as a tree and returns
 * the tree's id, and `git diff` between two trees says what one has that the
 * other does not. So the hash is what is kept, and git does the comparing.
 *
 * What that costs the repository is a tree object - content-addressed, shared
 * with every commit that has the same files, and pruned by `git gc` once
 * nothing refers to it. Pruned is survivable: the comparison then fails, and a
 * failure here removes nothing.
 */

function git(root: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? undefined : stdout)
    );
  });
}

/**
 * The index as a tree id, or undefined when git cannot say - not a
 * repository, or a merge in progress, whose index is not one tree yet.
 */
export async function indexTree(root: string): Promise<string | undefined> {
  const out = await git(root, ['write-tree']);
  const id = out && out.trim();
  return id && /^[0-9a-f]{40,64}$/.test(id) ? id : undefined;
}

/**
 * Files that were in the earlier index and are not in the later one, as
 * absolute paths.
 *
 * A rename counts as the old name leaving, because on a server that is what
 * it is: the old name is still sitting there. Undefined when git cannot
 * answer - a tree that has been pruned, say - which must never be read as
 * "nothing left".
 */
export async function leftBetween(
  root: string,
  before: string,
  after: string
): Promise<string[] | undefined> {
  const out = await git(root, [
    'diff',
    '--name-only',
    '--no-renames',
    '--diff-filter=D',
    '-z',
    before,
    after,
  ]);

  if (out === undefined) {
    return undefined;
  }

  return out
    .split('\0')
    .filter(one => one !== '')
    .map(one => path.join(root, one));
}
