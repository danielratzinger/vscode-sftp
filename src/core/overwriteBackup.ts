import * as fse from 'fs-extra';
import * as path from 'path';

/**
 * What a download replaced.
 *
 * VS Code's local history records what VS Code writes; a download is written
 * by this extension, so the editor never sees it and there is nothing in the
 * Timeline to go back to. Routing downloads through the editor's save pipeline
 * would fix that and would also hand the bytes to `files.trimTrailingWhitespace`,
 * `files.insertFinalNewline`, the configured encoding and format-on-save - the
 * file on disk would be what the editor decided to write rather than what the
 * server sent. A transfer has to be exact, so the copy is kept here instead.
 *
 * Only copies that could hold work of your own are kept: a file that matches
 * what is arriving is not worth keeping, and most of a folder download matches.
 */

export interface BackupOption {
  /** Where backups live, under the extension's global storage. */
  root: string;
  connectionId: string;
  /** How many versions of one file to keep. */
  keepPerFile: number;
  maxAgeDays: number;
}

export interface Backup {
  /** Stable enough to name in a command or a tool call. */
  id: string;
  /** Where the copy is. */
  path: string;
  localPath: string;
  timestamp: number;
  size: number;
}

export function backupRootFrom(globalStoragePath: string): string {
  return path.join(globalStoragePath, 'replaced');
}

/**
 * A file's own directory, mirroring its path so the store is legible when you
 * go looking, with one file per version inside it.
 */
export function mirrorFor(option: BackupOption, localPath: string): string {
  const parts = localPath
    .replace(/:/g, '_')
    .split(/[\\/]+/)
    .filter(part => part !== '' && part !== '.' && part !== '..');

  return path.join(option.root, option.connectionId, ...parts);
}

function toSeconds(mtime: number): number {
  return Math.floor(mtime / 1000);
}

async function statOrUndefined(file: string) {
  try {
    const stat = await fse.stat(file);
    return { size: stat.size, mtime: stat.mtime.getTime() };
  } catch (error) {
    return undefined;
  }
}

/**
 * Keeps what is about to be overwritten, when it is worth keeping.
 *
 * Nothing is kept when the file is not there, or when it already matches what
 * is arriving - which is most of a folder download, and would otherwise make
 * every download twice the writes.
 */
export async function keepReplaced(
  option: BackupOption,
  localPath: string,
  incoming: { size?: number; mtime: number },
  now: number = Date.now()
): Promise<Backup | undefined> {
  const local = await statOrUndefined(localPath);
  if (!local) {
    return undefined;
  }

  const sameFile =
    incoming.size !== undefined &&
    local.size === incoming.size &&
    toSeconds(local.mtime) === toSeconds(incoming.mtime);
  if (sameFile) {
    return undefined;
  }

  const folder = mirrorFor(option, localPath);
  const extension = path.extname(localPath);
  const target = path.join(folder, `${now}${extension}`);

  await fse.ensureDir(folder);
  await fse.copy(localPath, target, { preserveTimestamps: true });

  return {
    id: String(now),
    path: target,
    localPath,
    timestamp: now,
    size: local.size,
  };
}

/** Every kept copy of one file, newest first. */
export async function backupsFor(
  option: BackupOption,
  localPath: string
): Promise<Backup[]> {
  const folder = mirrorFor(option, localPath);

  let names: string[];
  try {
    names = await fse.readdir(folder);
  } catch (error) {
    return [];
  }

  const backups: Backup[] = [];
  for (const name of names) {
    const timestamp = parseInt(path.basename(name, path.extname(name)), 10);
    if (!isFinite(timestamp)) {
      continue;
    }

    const full = path.join(folder, name);
    const stat = await statOrUndefined(full);
    if (!stat) {
      continue;
    }

    backups.push({
      id: String(timestamp),
      path: full,
      localPath,
      timestamp,
      size: stat.size,
    });
  }

  return backups.sort((a, b) => b.timestamp - a.timestamp);
}

export async function readBackup(backup: Backup): Promise<string> {
  return fse.readFile(backup.path, 'utf8');
}

/**
 * Puts a copy back. The file it replaces is itself kept first, so restoring
 * the wrong version is not the end of the story.
 */
export async function restoreBackup(
  option: BackupOption,
  backup: Backup,
  now: number = Date.now()
): Promise<void> {
  const current = await statOrUndefined(backup.localPath);
  if (current) {
    await keepReplaced(
      option,
      backup.localPath,
      { size: backup.size, mtime: backup.timestamp },
      now
    );
  }

  await fse.ensureDir(path.dirname(backup.localPath));
  await fse.copy(backup.path, backup.localPath, { overwrite: true });
}

export interface PruneResult {
  removed: string[];
  bytesFreed: number;
}

/**
 * Old copies and surplus ones. Pruned on the same principle as everything else
 * kept on this machine: bounded by age and by count, so it cannot grow for
 * ever on its own.
 */
export async function pruneBackups(
  option: BackupOption,
  now: number = Date.now()
): Promise<PruneResult> {
  const root = path.join(option.root, option.connectionId);
  const removed: string[] = [];
  let bytesFreed = 0;
  const maxAge = option.maxAgeDays * 24 * 60 * 60 * 1000;

  async function sweep(dir: string): Promise<number> {
    let entries: string[];
    try {
      entries = await fse.readdir(dir);
    } catch (error) {
      return 0;
    }

    const versions: Array<{ file: string; timestamp: number; size: number }> = [];
    let kept = 0;

    for (const name of entries) {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = await fse.stat(full);
      } catch (error) {
        continue;
      }

      if (stat.isDirectory()) {
        kept += await sweep(full);
        continue;
      }

      const timestamp = parseInt(path.basename(name, path.extname(name)), 10);
      versions.push({
        file: full,
        timestamp: isFinite(timestamp) ? timestamp : 0,
        size: stat.size,
      });
    }

    versions.sort((a, b) => b.timestamp - a.timestamp);

    for (let at = 0; at < versions.length; at += 1) {
      const version = versions[at];
      const tooOld = now - version.timestamp > maxAge;
      const surplus = at >= option.keepPerFile;

      if (!tooOld && !surplus) {
        kept += 1;
        continue;
      }

      try {
        await fse.unlink(version.file);
        removed.push(version.file);
        bytesFreed += version.size;
      } catch (error) {
        kept += 1;
      }
    }

    if (kept === 0 && dir !== root) {
      try {
        await fse.rmdir(dir);
      } catch (error) {
        // Something arrived while we were looking; leave it.
      }
    }

    return kept;
  }

  await sweep(root);

  return { removed, bytesFreed };
}
