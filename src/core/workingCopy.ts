import * as fs from 'fs';
import * as path from 'path';
import { isSubpathOf } from '../helper';

/**
 * Whether a folder is a working copy of something.
 *
 * Two questions turn on it. `Clear Local Folder` must not be offered on one:
 * clearing is for a download that has to start from nothing, and nothing in a
 * working copy is that. And `Remove Files Deleted from the Repository` has
 * nothing to ask without one - its whole answer comes from git's history.
 *
 * Here rather than beside the tree that displays it, because the answer is
 * about a folder on disk and both the tree and the autosync side need it. The
 * tree importing from autosync and autosync importing from the tree is a cycle.
 */

/** What makes the local copy of a folder a working copy of something. */
const REPOSITORY_MARKERS = ['.git', '.svn', '.hg'];

/**
 * `.git` can be a file rather than a folder, in a worktree or a submodule, so
 * this asks whether the name is there at all.
 */
function holdsARepository(dir: string): boolean {
  return REPOSITORY_MARKERS.some(marker => {
    try {
      return fs.existsSync(path.join(dir, marker));
    } catch (error) {
      return false;
    }
  });
}

/**
 * Answers kept for the life of a tree, because this is asked once per visible
 * item and the walk repeats itself all the way up every time.
 */
const repositoryAnswers = new Map<string, boolean>();

export function forgetRepositoryAnswers(): void {
  repositoryAnswers.clear();
}

/**
 * Whether the local copy of this remote folder is in a repository - its own,
 * or one it sits inside.
 *
 * Only `Clear Local Folder` asks. Clearing a folder is for a download that has
 * to start from nothing, and nothing in a working copy is that: the files are
 * tracked, the history is beside them, and what the command would delete is
 * not what a download would put back.
 *
 * The walk stops at the workspace folder. A repository above the folder the
 * editor has open is not this extension's business, and an unbounded walk
 * makes the answer depend on how somebody keeps their home directory.
 */
export function localCopyIsInARepository(local: string, workspace: string): boolean {
  const held = repositoryAnswers.get(local);
  if (held !== undefined) {
    return held;
  }

  const stop = path.resolve(workspace);
  let dir = path.resolve(local);
  let answer = false;

  for (;;) {
    if (holdsARepository(dir)) {
      answer = true;
      break;
    }

    const up = path.dirname(dir);
    if (dir === stop || up === dir || !isSubpathOf(stop, up)) {
      break;
    }
    dir = up;
  }

  repositoryAnswers.set(local, answer);
  return answer;
}
