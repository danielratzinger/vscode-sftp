import * as path from 'path';
import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import logger from '../logger';
import { getUserSetting } from '../host';
import { FileService } from '../core';
import { FileType } from '../core/fs/fileSystem';
import connectionLabel from '../core/connectionLabel';
import { connectionKeyFor } from './replacedFiles';
import {
  Fetched,
  RemoteBackupOption,
  connectionsWithBackups,
  keepRemote,
  pruneRemoteBackups,
  restorePoints,
  sessionsOf,
  stampFor,
  storedAt,
  Session,
} from '../core/remoteBackup';

/**
 * The store of what the server had, wired to the editor.
 *
 * Where it lives, whether it is wanted, which session a connection is writing
 * into, and the sweep that keeps it from growing without end.
 *
 * A session is one run of autosync for one connection: it starts when the
 * connection starts syncing and ends when it stops or the window closes. That
 * boundary is what makes "put it back to before this started" a question with
 * an answer.
 */

let storageRoot = '';

/** The session each connection is currently writing into. */
const sessions = new Map<string, string>();

/** Files this session has already kept, so the server is asked once each. */
const keptAlready = new Map<string, Set<string>>();

export function initAutosyncBackup(context: vscode.ExtensionContext): void {
  storageRoot = path.join(context.globalStoragePath, 'remote-backups');

  // A sweep at startup, so a machine left alone for months does not still hold
  // what it held a year ago.
  sweep().catch(error =>
    logger.debug(`could not sweep the remote backups: ${error.message}`)
  );
}

function settings() {
  return getUserSetting('sftp');
}

export function isEnabled(): boolean {
  return Boolean(storageRoot) && settings().get<boolean>('autosync.backupRemote', true);
}

export function optionFor(connectionId: string): RemoteBackupOption {
  return {
    root: storageRoot,
    connectionId,
    maxAgeDays: settings().get<number>('autosync.backupDays', 30),
  };
}

export function connectionIdOf(service: FileService): string {
  return connectionKeyFor(service.getConfig() as any);
}

/** A connection started syncing: everything from here belongs to one moment. */
export function startSession(service: FileService): void {
  const id = connectionIdOf(service);
  sessions.set(id, stampFor());
  keptAlready.set(id, new Set());
}

export function endSession(service: FileService): void {
  const id = connectionIdOf(service);
  sessions.delete(id);
  keptAlready.delete(id);
}

function sessionOf(service: FileService): string {
  const id = connectionIdOf(service);
  let stamp = sessions.get(id);

  if (!stamp) {
    // Syncing resumed from a previous window without anybody starting it.
    stamp = stampFor();
    sessions.set(id, stamp);
    keptAlready.set(id, new Set());
  }

  return stamp;
}

/** Bigger than this and the copy is not made; see `tooBig`. */
function sizeLimit(): number {
  const mb = settings().get<number>('autosync.backupMaxMB', 20);
  return (typeof mb === 'number' && mb > 0 ? mb : 20) * 1024 * 1024;
}

/**
 * Reads what the server has, saying plainly which of the four cases it is.
 *
 * `tooBig` is its own answer rather than a failure or an absence, and that
 * matters: a failure would stop the upload for ever, and an absence would tell
 * a restore to delete a file that was there. It means "this one has no way
 * back", which is said out loud and then allowed.
 */
async function fetchRemote(
  service: FileService,
  remotePath: string
): Promise<Fetched | 'tooBig' | 'notAFile'> {
  try {
    const config = service.getConfig();
    const remoteFs = await service.getRemoteFileSystem(config);

    const stat = await remoteFs.lstat(remotePath).catch(error => {
      // Not there is an answer, not a failure - but only when the server said
      // so about this file, rather than the connection falling over.
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    });

    if (!stat) {
      return { kind: 'absent' };
    }

    // A directory has no bytes to keep, and reading one fails in a way that
    // looks exactly like a server that cannot be reached - which is how the
    // queue ended up retrying the watched root for ever.
    if (stat.type === FileType.Directory) {
      return 'notAFile';
    }

    // The copy is held in memory on the way to disk, so a database dump or a
    // video would take the window with it.
    if (typeof stat.size === 'number' && stat.size > sizeLimit()) {
      return 'tooBig';
    }

    const content = await remoteFs.readFile(remotePath);
    return {
      kind: 'bytes',
      bytes: Buffer.isBuffer(content) ? content : Buffer.from(content),
    };
  } catch (error) {
    return { kind: 'failed', error };
  }
}

function isNotFound(error: any): boolean {
  const code = error && (error.code || error.errno);
  return (
    code === 2 ||
    code === 'ENOENT' ||
    /no such file|not found|does not exist/i.test((error && error.message) || '')
  );
}

/**
 * Keeps the server's copy before this session first writes over it.
 *
 * Returns whether the upload may go ahead. It may not when the server could
 * not be reached, because that is exactly the case where an overwrite would
 * destroy the only copy of what was there - the caller puts the file back in
 * the queue and tries again.
 */
export async function clearToOverwrite(
  service: FileService,
  remotePath: string
): Promise<boolean> {
  if (!isEnabled()) {
    return true;
  }

  const id = connectionIdOf(service);
  const stamp = sessionOf(service);
  const seen = keptAlready.get(id)!;

  if (seen.has(remotePath)) {
    return true; // Once per file per session: the point is the state before.
  }

  const fetched = await fetchRemote(service, remotePath);

  if (fetched === 'notAFile') {
    // Nothing is written down for it: a directory is not a thing a restore
    // puts back, and recording it as absent would tell one to remove it.
    seen.add(remotePath);
    return true;
  }

  if (fetched === 'tooBig') {
    // Nothing is written down for it at all. Recording it as absent would
    // tell a restore to delete a file that was there, and recording it as
    // failed would stop it being deployed for ever; the honest answer is
    // "this one has no way back", said out loud and then allowed.
    logger
      .for(connectionLabel(service.getConfig() as any))
      .warn(
        `[autosync] ${remotePath} is larger than ` +
          `${Math.round(sizeLimit() / 1024 / 1024)} MB, so the server's copy ` +
          'was not kept. It will be overwritten with no way back ' +
          '(sftp.autosync.backupMaxMB).'
      );
    seen.add(remotePath);
    return true;
  }

  const result = await keepRemote(
    optionFor(id),
    stamp,
    remotePath,
    async () => fetched
  ).catch(error => {
    logger.warn(`could not keep ${remotePath}: ${error.message}`);
    return 'failed' as const;
  });

  if (result === 'failed') {
    logger
      .for(connectionLabel(service.getConfig() as any))
      .warn(
        `[autosync] not overwriting ${remotePath}: the server's copy could not ` +
          'be kept. It will be tried again.'
      );
    return false;
  }

  seen.add(remotePath);
  return true;
}

export function sessionsFor(service: FileService): Promise<Session[]> {
  return storageRoot
    ? sessionsOf(optionFor(connectionIdOf(service)))
    : Promise.resolve([]);
}

export interface Restorable {
  remotePath: string;
  /** Where the bytes are, or undefined when the file was not there at all. */
  from?: string;
}

/** What putting this connection back to `stamp` would do. */
export async function whatToRestore(
  service: FileService,
  stamp: string
): Promise<Restorable[]> {
  const option = optionFor(connectionIdOf(service));

  const points = await restorePoints(option, stamp);
  const restorable: Restorable[] = [];

  for (const point of points) {
    if (point.absent) {
      restorable.push({ remotePath: point.remotePath });
      continue;
    }

    const from = storedAt(option, point.stamp, point.remotePath);
    if (await fse.pathExists(from)) {
      restorable.push({ remotePath: point.remotePath, from });
    }
  }

  return restorable;
}

/** Sweeps every connection that has kept anything. */
async function sweep(): Promise<void> {
  if (!storageRoot) {
    return;
  }

  for (const connectionId of await connectionsWithBackups(storageRoot)) {
    const swept = await pruneRemoteBackups(optionFor(connectionId));
    if (swept.removed.length > 0) {
      logger.info(
        `[autosync] swept ${swept.removed.length} old backup session` +
          `${swept.removed.length === 1 ? '' : 's'} ` +
          `(${Math.round(swept.bytesFreed / 1024)} KB)`
      );
    }
  }
}

/** Sweeps one connection, on the way into a new session. */
export function sweepFor(service: FileService): Promise<unknown> {
  return storageRoot
    ? pruneRemoteBackups(optionFor(connectionIdOf(service))).catch(() => undefined)
    : Promise.resolve();
}
