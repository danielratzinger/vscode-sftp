import * as path from 'path';
import { execFile } from 'child_process';

/**
 * What a checkout has that the deployed branch does not.
 *
 * Picking a worktree to deploy from usually happens after the work has
 * started - an agent has been writing for twenty minutes before anybody
 * notices. Watching from that moment leaves everything before it behind, and
 * pushing the whole checkout to fix that is a deploy when what was wanted was
 * a catch-up.
 *
 * So: the files this branch changed, and the files that are not committed
 * yet. Two questions to git, unioned, which is a fraction of a comparison
 * against the server and needs no connection to work out.
 *
 * The base it compares against is the branch the window's own worktree is on,
 * because that is what was being deployed until now. It is a guess at what the
 * server holds - the exact answer needs the server, which is `Sync Local ->
 * Remote` - so it is named wherever it is shown.
 */

export interface WorktreeChanges {
  /** Absolute paths to upload, in git's order. */
  changed: string[];
  /** Absolute paths git says are gone. */
  deleted: string[];
  /** What the comparison was against, for saying so. */
  base?: string;
}

/** `git diff --name-status`: `M\tpath`, `A\tpath`, `R100\told\tnew`. */
export function parseNameStatus(
  text: string
): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];

  text.split('\n').forEach(line => {
    if (line.trim() === '') {
      return;
    }

    const parts = line.split('\t');
    const status = parts[0];
    // A rename reports the old path and the new one; the new one is the file
    // that now exists, and the old one is gone from the server's point of view.
    const target = parts[parts.length - 1];
    const previous = parts.length > 2 ? parts[1] : undefined;

    if (status.charAt(0) === 'D') {
      deleted.push(target);
      return;
    }

    if (previous) {
      deleted.push(previous);
    }
    changed.push(target);
  });

  return { changed, deleted };
}

/** A path git quotes because of what is in it. */
function unquote(text: string): string {
  if (text.charAt(0) !== '"') {
    return text;
  }

  return text
    .slice(1, -1)
    .replace(/\\([\\"])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}

/** `git status --porcelain -uall`: two status characters, a space, a path. */
export function parsePorcelain(
  text: string
): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];

  text.split('\n').forEach(line => {
    if (line.length < 4) {
      return;
    }

    const status = line.slice(0, 2);
    const rest = line.slice(3);

    // `R  old -> new`, in either column.
    if (status.indexOf('R') !== -1 && rest.indexOf(' -> ') !== -1) {
      const [from, to] = rest.split(' -> ');
      deleted.push(unquote(from));
      changed.push(unquote(to));
      return;
    }

    const file = unquote(rest);

    if (status === ' D' || status === 'D ' || status === 'DD') {
      deleted.push(file);
      return;
    }

    changed.push(file);
  });

  return { changed, deleted };
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout)
    );
  });
}

function unique(paths: string[]): string[] {
  const seen: { [file: string]: true } = Object.create(null);

  return paths.filter(file => {
    if (seen[file]) {
      return false;
    }
    seen[file] = true;
    return true;
  });
}

/**
 * Everything this checkout has moved on by, as absolute paths.
 *
 * Without a base - the window's worktree is detached, or git is not on the
 * PATH - this is what is uncommitted and nothing else, which is the part that
 * can always be worked out.
 */
export async function changesIn(
  root: string,
  base?: string
): Promise<WorktreeChanges> {
  const changed: string[] = [];
  const deleted: string[] = [];
  let comparedWith: string | undefined;

  if (base) {
    // Three dots: what this branch did since it parted from that one, rather
    // than everything that has happened on both since.
    const diff = await git(root, ['diff', '--name-status', `${base}...HEAD`]);
    if (diff !== undefined) {
      const parsed = parseNameStatus(diff);
      changed.push(...parsed.changed);
      deleted.push(...parsed.deleted);
      comparedWith = base;
    }
  }

  const status = await git(root, ['status', '--porcelain', '-uall']);
  if (status !== undefined) {
    const parsed = parsePorcelain(status);
    changed.push(...parsed.changed);
    deleted.push(...parsed.deleted);
  }

  const absolute = (file: string) => path.join(root, file);
  // A file that was deleted and then written again is a change, not a delete.
  const changedSet = unique(changed);
  const gone = unique(deleted).filter(file => changedSet.indexOf(file) === -1);

  return {
    changed: changedSet.map(absolute),
    deleted: gone.map(absolute),
    base: comparedWith,
  };
}
