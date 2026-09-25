import { FileEntry, FileSystem, FileType } from '../fs';

/** What is on this machine, ready to be named in an archive. */
export interface LocalTree {
  /** Files and symlinks, relative to the base, with forward slashes. */
  files: Array<{ path: string; mode?: number }>;
  /** Every folder below the base, relative to it, parents before children. */
  directories: string[];
}

export interface WalkOption {
  ignore?: ((fsPath: string) => boolean) | null;
  fileFilter?: ((fsPath: string) => boolean) | null;
}

/**
 * Walks a folder on this machine, applying the same filters the transfer walk
 * applies and in the same places: `ignore` to everything, `fileFilter` to
 * files and symlinks but never to folders.
 *
 * On disk rather than over the wire, so it costs no round trips - which is why
 * an upload can know how many files there are before deciding how to send them,
 * and a download cannot.
 *
 * Folders are listed whether or not they hold anything, because an empty folder
 * is something the transfer creates today and an archive of files alone would
 * lose.
 */
export async function walkLocal(
  fs: FileSystem,
  base: string,
  option: WalkOption = {}
): Promise<LocalTree> {
  const tree: LocalTree = { files: [], directories: [] };

  const walk = async (dir: string, prefix: string) => {
    let entries: FileEntry[];
    try {
      entries = await fs.list(dir);
    } catch (error) {
      // A folder that cannot be read is one folder's failure, as it is file by
      // file. What is readable still goes.
      return;
    }

    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (option.ignore && option.ignore(entry.fspath)) {
        continue;
      }

      if (entry.type === FileType.Directory) {
        tree.directories.push(relative);
        await walk(entry.fspath, relative);
        continue;
      }

      if (option.fileFilter && !option.fileFilter(entry.fspath)) {
        continue;
      }

      if (entry.type === FileType.File) {
        tree.files.push({ path: relative, mode: entry.mode });
        continue;
      }

      if (entry.type === FileType.SymbolicLink) {
        // No mode: it belongs to whatever the link points at, and changing it
        // through the link would change that instead.
        tree.files.push({ path: relative });
      }
    }
  };

  await walk(base, '');
  return tree;
}
