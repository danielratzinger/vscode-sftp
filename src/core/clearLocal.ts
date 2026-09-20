import * as path from 'path';
import * as fse from 'fs-extra';

/**
 * What clearing a local folder would remove.
 *
 * Worked out before anything is deleted, for two reasons. Somebody about to
 * lose the contents of a folder should be told how much of it there is - "18
 * files, 240 KB" is a different decision from "1,400 files, 90 MB". And the
 * answer is the plan: whatever the survey says it will delete is exactly what
 * gets deleted, rather than a second walk arriving somewhere else.
 *
 * A folder nothing keeps back is removed whole, which is one operation rather
 * than one per file. A folder with anything kept inside it is removed piece by
 * piece, so that what is kept survives.
 */

export interface Clearance {
  /** Paths to remove, each the shallowest one that can go as a unit. */
  paths: string[];
  files: number;
  bytes: number;
  /** Files left alone because something said to keep them. */
  kept: number;
  /** Why the first of them was kept, for saying so once. */
  keptFor?: string;
}

export interface ClearOption {
  /**
   * The connection's own ignore rules. A file the sync never touches is not
   * an old version of anything, and deleting it is beyond what was asked.
   */
  ignore?: (fsPath: string) => boolean;
  /**
   * Names never removed whatever else says, checked at every level.
   *
   * A repository is not an old copy of the deployed files; it is the history
   * of them, it is not on the server, and no download would put it back.
   */
  never?: string[];
}

export const NEVER_REMOVED = ['.git', '.svn', '.hg', '.vscode'];

interface Below extends Clearance {
  /** True when everything below this can go, so the folder itself can. */
  whole: boolean;
}

async function survey(dir: string, option: ClearOption): Promise<Below> {
  const never = option.never || NEVER_REMOVED;
  const found: Below = { paths: [], files: 0, bytes: 0, kept: 0, whole: true };

  let entries: string[];
  try {
    entries = await fse.readdir(dir);
  } catch (error) {
    // Unreadable is not deletable, and not worth failing the rest over.
    return { ...found, whole: false };
  }

  for (const name of entries) {
    const full = path.join(dir, name);

    if (never.indexOf(name) !== -1) {
      found.kept += 1;
      found.keptFor = found.keptFor || `${name} is never removed`;
      found.whole = false;
      continue;
    }

    if (option.ignore && option.ignore(full)) {
      found.kept += 1;
      found.keptFor = found.keptFor || `${name} is ignored by this connection`;
      found.whole = false;
      continue;
    }

    let stat;
    try {
      stat = await fse.lstat(full);
    } catch (error) {
      continue;
    }

    if (stat.isDirectory()) {
      const below = await survey(full, option);
      found.files += below.files;
      found.bytes += below.bytes;
      found.kept += below.kept;
      found.keptFor = found.keptFor || below.keptFor;

      if (below.whole) {
        found.paths.push(full);
      } else {
        found.paths.push(...below.paths);
        found.whole = false;
      }
      continue;
    }

    found.paths.push(full);
    found.files += 1;
    found.bytes += stat.size;
  }

  return found;
}

/**
 * What would be removed from this folder, leaving the folder itself.
 */
export async function planClearance(
  dir: string,
  option: ClearOption = {}
): Promise<Clearance> {
  const below = await survey(dir, option);

  return {
    paths: below.paths,
    files: below.files,
    bytes: below.bytes,
    kept: below.kept,
    keptFor: below.keptFor,
  };
}

/** Whether `inner` is `outer` or sits below it. */
export function isWithin(outer: string, inner: string): boolean {
  const relative = path.relative(path.resolve(outer), path.resolve(inner));

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
