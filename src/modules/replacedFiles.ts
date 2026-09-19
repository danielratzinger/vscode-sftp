import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import logger from '../logger';
import { getUserSetting } from '../host';
import {
  Backup,
  BackupOption,
  backupRootFrom,
  backupsFor,
  keepReplaced,
  pruneBackups,
  restoreBackup,
} from '../core/overwriteBackup';

/**
 * Wires the store of replaced files to the editor: where it lives, whether it
 * is wanted, and when it is swept.
 */

let storageRoot = '';

export function initReplacedFiles(context: vscode.ExtensionContext): void {
  storageRoot = backupRootFrom(context.globalStoragePath);

  // A sweep at startup, so a machine that was left alone for months does not
  // keep what it kept a year ago.
  sweep().catch(error => logger.debug(`could not sweep replaced files: ${error.message}`));
}

function settings() {
  return getUserSetting('sftp');
}

/**
 * What a connection's copies are filed under. Two servers that map to the same
 * folder keep separate histories, and the same server keeps one across
 * sessions - so it cannot be the service id, which is assigned per window.
 */
export function connectionKeyFor(config: {
  remotePath?: string;
  host?: string;
}): string {
  return `${config.remotePath || ''}@${config.host || 'local'}`.replace(
    /[\\/:]+/g,
    '_'
  );
}

export function isEnabled(): boolean {
  return Boolean(storageRoot) && settings().get<boolean>('keepReplacedFiles', true);
}

export function optionFor(connectionId: string): BackupOption {
  return {
    root: storageRoot,
    connectionId,
    keepPerFile: settings().get<number>('keepReplacedFilesPerFile', 5),
    maxAgeDays: settings().get<number>('keepReplacedFilesDays', 30),
  };
}

/**
 * The hook a download hands to the transfer: it decides nothing about the
 * transfer, and a failure here never stops one.
 */
export function keepReplacedFor(connectionId: string) {
  if (!isEnabled()) {
    return undefined;
  }

  return async (localPath: string, incoming: { size?: number; mtime: number }) => {
    const kept = await keepReplaced(optionFor(connectionId), localPath, incoming);
    if (kept) {
      logger.info(`[replaced] kept a copy of ${localPath} before downloading over it`);
    }
  };
}

export function versionsOf(connectionId: string, localPath: string): Promise<Backup[]> {
  return storageRoot ? backupsFor(optionFor(connectionId), localPath) : Promise.resolve([]);
}

export function restore(connectionId: string, backup: Backup): Promise<void> {
  return restoreBackup(optionFor(connectionId), backup);
}

/** The connections that have kept anything, for the restore command. */
export async function connectionsHolding(): Promise<string[]> {
  if (!storageRoot) {
    return [];
  }

  try {
    return await fse.readdir(storageRoot);
  } catch (error) {
    return [];
  }
}

/** Prunes every connection that has kept anything. */
async function sweep(): Promise<void> {
  if (!storageRoot) {
    return;
  }

  let connections: string[];
  try {
    connections = await fse.readdir(storageRoot);
  } catch (error) {
    return;
  }

  for (const connectionId of connections) {
    const result = await pruneBackups(optionFor(connectionId));
    if (result.removed.length > 0) {
      logger.info(
        `[replaced] removed ${result.removed.length} old copies ` +
          `(${Math.round(result.bytesFreed / 1024)} KB)`
      );
    }
  }
}
