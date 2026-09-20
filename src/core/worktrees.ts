import * as path from 'path';
import * as fse from 'fs-extra';

/**
 * The worktrees of a repository, read from git's own metadata.
 *
 * An agent working on a branch of a project gets its own checkout - a linked
 * worktree, usually nowhere near the folder the editor has open. There is
 * nothing to scan for: git records every one of them under
 * `.git/worktrees/<name>/`, two small files each, and keeps that up to date
 * itself. Reading it costs nothing and needs no `git` on the PATH.
 *
 * Three things here are traps for anyone who assumes instead of reads. The
 * directory under `.git/worktrees` is *not* the branch - it is taken from the
 * last segment of the checkout's path, so two agents both working in `portal`
 * produce `portal` and `portal1`. An entry outlives the folder it points at,
 * because removing a checkout by hand leaves the metadata behind - git calls
 * that prunable, and so does this. And a worktree can be checked out at a
 * commit rather than a branch, which has no name at all.
 */

export interface Worktree {
  /** The checkout's root on this machine. */
  root: string;
  /** `refs/heads/x` as `x`, or undefined when it is detached. */
  branch?: string;
  /** The repository's own folder, as opposed to a linked checkout. */
  isMain: boolean;
  /** False when the metadata points at a folder that is no longer there. */
  exists: boolean;
  /** What git filed it under, which is not the branch. */
  name: string;
}

async function firstLine(file: string): Promise<string | undefined> {
  try {
    const text = await fse.readFile(file, 'utf8');
    return text.split('\n')[0].trim() || undefined;
  } catch (error) {
    return undefined;
  }
}

function branchOf(head: string | undefined): string | undefined {
  if (!head) {
    return undefined;
  }

  const match = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  return match ? match[1] : undefined;
}

/**
 * The repository's own `.git` directory, from anywhere inside any of its
 * worktrees.
 *
 * In the repository's own folder `.git` is a directory. In a linked checkout
 * it is a file saying `gitdir: <repo>/.git/worktrees/<name>`, and `commondir`
 * beside that points back at the `.git` every worktree shares.
 */
export async function gitDirOf(startDir: string): Promise<string | undefined> {
  let dir = path.resolve(startDir);

  for (;;) {
    const candidate = path.join(dir, '.git');

    try {
      const stat = await fse.stat(candidate);

      if (stat.isDirectory()) {
        return candidate;
      }

      if (stat.isFile()) {
        const pointer = await firstLine(candidate);
        const linked = pointer && pointer.replace(/^gitdir:\s*/, '');
        if (!linked) {
          return undefined;
        }

        const common = await firstLine(path.join(linked, 'commondir'));
        return common ? path.resolve(linked, common) : undefined;
      }
    } catch (error) {
      // Not here; keep climbing.
    }

    const up = path.dirname(dir);
    if (up === dir) {
      return undefined;
    }
    dir = up;
  }
}

/** Every worktree of the repository that contains `startDir`. */
export async function worktreesOf(startDir: string): Promise<Worktree[]> {
  const gitDir = await gitDirOf(startDir);
  if (!gitDir) {
    return [];
  }

  const main: Worktree = {
    root: path.dirname(gitDir),
    branch: branchOf(await firstLine(path.join(gitDir, 'HEAD'))),
    isMain: true,
    exists: true,
    name: path.basename(path.dirname(gitDir)),
  };

  let names: string[];
  try {
    names = await fse.readdir(path.join(gitDir, 'worktrees'));
  } catch (error) {
    return [main]; // A repository with no linked checkouts has no such folder.
  }

  const linked: Worktree[] = [];
  for (const name of names.sort()) {
    const held = path.join(gitDir, 'worktrees', name);
    const pointer = await firstLine(path.join(held, 'gitdir'));
    if (!pointer) {
      continue;
    }

    // The pointer is to the checkout's own `.git` file, not to the checkout.
    const root = path.dirname(pointer);

    linked.push({
      root,
      branch: branchOf(await firstLine(path.join(held, 'HEAD'))),
      isMain: false,
      exists: await fse.pathExists(root),
      name,
    });
  }

  return [main, ...linked];
}

/** Where to watch for a worktree appearing or being removed. */
export async function worktreeRegistryOf(
  startDir: string
): Promise<string | undefined> {
  const gitDir = await gitDirOf(startDir);
  return gitDir ? path.join(gitDir, 'worktrees') : undefined;
}

/** How a worktree is named in a list somebody has to choose from. */
export function describeWorktree(worktree: Worktree): string {
  const where = worktree.isMain ? 'this window' : worktree.root;

  return `${worktree.branch || 'detached'} — ${where}`;
}
