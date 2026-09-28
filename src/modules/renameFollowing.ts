import * as vscode from 'vscode';
import { FileType } from '../core';
import { handleCtxFromUri, renameRemote } from '../fileHandlers';
import {
  CANCEL,
  Occupant,
  whatToAsk,
  worthPassingOn,
} from '../core/renameName';
import { getUserSetting, showWarningMessage } from '../host';
import { getFileService } from './serviceManager';
import { autosyncState } from './worktreeSync';
import logger from '../logger';

/**
 * Passing a rename made here on to the server.
 *
 * Renaming a file in the editor used to leave the server with the old name, and
 * since a download writes and never removes, the next one brought back both.
 * Nothing noticed: a rename is not a save, so none of the paths that upload on
 * save ever heard about it.
 *
 * Always asked, never assumed. A rename is not a save, and nobody renaming a
 * file in an editor has necessarily decided to change a server - which is the
 * whole reason `uploadOnSave` is a setting somebody turns on deliberately. Set
 * `sftp.renameOnServer` to `off` to stop being asked.
 */
type Behaviour = 'ask' | 'off';

let watcher: vscode.Disposable | undefined;

interface Renamed {
  oldUri: vscode.Uri;
  newUri: vscode.Uri;
}

/** What is at a path on the server, or nothing when there is nothing there. */
async function onServer(uri: vscode.Uri): Promise<Occupant> {
  try {
    const ctx = handleCtxFromUri(uri);
    const remoteFs = await ctx.fileService.getRemoteFileSystem(ctx.config);
    const stat = await remoteFs.lstat(ctx.target.remoteFsPath);
    return stat.type === FileType.Directory ? 'directory' : 'file';
  } catch (error) {
    return 'nothing';
  }
}

/**
 * The renames this is willing to put to somebody.
 *
 * A file the server has never seen is not a rename there, it is nothing - and
 * asking about it would make every rename in a new folder a question. So the old
 * name has to be on the server for there to be anything to do.
 *
 * A connection that autosync is writing is left to autosync, which passes on
 * what leaves the branch by itself and would undo this one anyway.
 */
async function worthAsking(renamed: Renamed[]): Promise<Renamed[]> {
  const worth: Renamed[] = [];

  for (const one of renamed) {
    const service = getFileService(one.newUri) || getFileService(one.oldUri);
    const config = service && service.getConfig();

    const verdict = worthPassingOn({
      hasConnection: Boolean(service),
      autosyncing: Boolean(service && autosyncState(service)),
      ignored: Boolean(config && config.ignore && config.ignore(one.oldUri.fsPath)),
      onServer: service ? await onServer(one.oldUri) : 'nothing',
    });

    if (!verdict.ask) {
      logger.debug(`[rename] ${one.oldUri.fsPath} not offered: ${verdict.because}`);
      continue;
    }

    worth.push(one);
  }

  return worth;
}

const RENAME = 'Rename on the Server';

function describe(renamed: Renamed[]): string {
  if (renamed.length === 1) {
    return (
      `${basename(renamed[0].oldUri)} was renamed to ` +
      `${basename(renamed[0].newUri)}. Rename it on the server too?`
    );
  }

  return `${renamed.length} files were renamed. Rename them on the server too?`;
}

function basename(uri: vscode.Uri): string {
  const parts = uri.fsPath.split(/[\\/]/);
  return parts[parts.length - 1];
}

/**
 * Puts one rename to the server, asking again if the new name is taken there.
 *
 * The local rename has already happened, so this only tells the server - and the
 * copy here is not touched whatever the answer.
 */
async function pass(one: Renamed): Promise<void> {
  const standing = await onServer(one.newUri);

  if (standing !== 'nothing') {
    const ask = whatToAsk({ remote: standing, local: 'nothing' }, basename(one.newUri));

    if (ask.refuse) {
      showWarningMessage(ask.refuse);
      return;
    }

    const answer = await showWarningMessage(ask.message!, ...ask.choices!);
    if (!answer || answer === CANCEL) {
      return;
    }
  }

  await renameRemote(one.newUri, {
    originUri: one.oldUri,
    // It has already been renamed here; this is only the server catching up.
    renameLocal: false,
    overwrite: standing !== 'nothing',
  });
}

export function initRenameFollowing(): void {
  if (watcher) {
    watcher.dispose();
  }

  watcher = vscode.workspace.onDidRenameFiles(async event => {
    const behaviour = getUserSetting('sftp').get<Behaviour>('renameOnServer', 'ask');
    if (behaviour === 'off') {
      return;
    }

    try {
      const worth = await worthAsking(
        event.files.map(one => ({ oldUri: one.oldUri, newUri: one.newUri }))
      );

      if (worth.length === 0) {
        return;
      }

      // Once for the batch: renaming a folder of files is one decision, and one
      // question per file would be a dialog somebody dismisses without reading.
      const answer = await showWarningMessage(describe(worth), RENAME, CANCEL);
      if (answer !== RENAME) {
        return;
      }

      for (const one of worth) {
        try {
          await pass(one);
        } catch (error) {
          logger.error(`[rename] ${one.oldUri.fsPath}: ${error.message}`);
        }
      }
    } catch (error) {
      logger.error(`[rename] ${error.message}`);
    }
  });
}

export function disposeRenameFollowing(): void {
  if (watcher) {
    watcher.dispose();
    watcher = undefined;
  }
}
