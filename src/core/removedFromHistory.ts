import * as path from 'path';
import * as fse from 'fs-extra';
import { execFile } from 'child_process';

/**
 * Files the project used to have and does not any more.
 *
 * A server accumulates. `Download Scripts` writes and never removes, and a
 * deploy of any kind uploads what exists rather than removing what stopped
 * existing - so a site deployed across a year holds files deleted from the
 * project months ago. Autosync takes files off the server as they leave git's
 * index, but only from the moment it starts watching; everything dropped
 * before that is still there.
 *
 * Asked of git's history rather than of the server, and that is the point.
 * Comparing against a listing answers a different and more dangerous question
 * - "what is on the server that is not on my disk" - whose answer includes
 * every runtime directory, upload folder and cache the site legitimately keeps
 * and the repository deliberately ignores. This only ever names paths the
 * repository itself once tracked, so there is no answer it can give that
 * removes something the project never owned.
 *
 * Renames are counted as a deletion of the old path, which is what they are as
 * far as a server is concerned: the old name is still sitting there.
 */

/** `git log --name-only --pretty=format:` output: paths and blank lines. */
export function parseDeleted(text: string): string[] {
  const seen = new Set<string>();

  text.split('\n').forEach(line => {
    const file = line.trim();
    if (file !== '') {
      seen.add(file);
    }
  });

  return Array.from(seen).sort();
}

/**
 * Every path deleted somewhere in this checkout's history.
 *
 * `undefined` when git cannot answer, which is not the same as "nothing was
 * ever deleted" - one of those is a reason to remove files from a server.
 */
export function everDeletedIn(
  root: string,
  mostCommits = 5000
): Promise<string[] | undefined> {
  return new Promise(resolve => {
    execFile(
      'git',
      [
        'log',
        // A rename would otherwise be neither an add nor a delete, and the old
        // path would stay on the server for ever.
        '--no-renames',
        '--diff-filter=D',
        '--name-only',
        '--pretty=format:',
        `-n${mostCommits}`,
        'HEAD',
      ],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : parseDeleted(stdout))
    );
  });
}

/**
 * Of those, the ones that really are gone from this checkout.
 *
 * A file deleted in one commit and written again in another is not deleted;
 * the history says both things and only the disk settles it.
 */
export async function stillGoneIn(
  root: string,
  deleted: string[]
): Promise<string[]> {
  const gone: string[] = [];

  for (const file of deleted) {
    if (!(await fse.pathExists(path.join(root, file)))) {
      gone.push(file);
    }
  }

  return gone;
}
