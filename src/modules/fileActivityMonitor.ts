import * as vscode from 'vscode';
import logger, { withConnection } from '../logger';
import { realpathSync } from 'fs';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';
import { onDidOpenTextDocument, onDidSaveTextDocument, showConfirmMessage } from '../host';
import { readConfigsFromFile } from './config';
import {
  createFileService,
  getFileService,
  findAllFileService,
  disposeFileService,
} from './serviceManager';
import { reportError, isValidFile, isConfigFile, isInWorkspace } from '../helper';
import connectionLabel from '../core/connectionLabel';
import * as path from 'path';
import { upath, UResource } from '../core';
import { autosyncState, resumeAutosync, sayIfPaused } from './worktreeSync';
import { forgetRemoteCopy, remoteCopyAt, RemoteCopy } from './remoteEdits';
import { downloadFile, uploadFile } from '../fileHandlers';
import { FileHandlerContext } from '../fileHandlers/createFileHandler';

let workspaceWatcher: vscode.Disposable;
let closeWatcher: vscode.Disposable | undefined;

async function handleConfigSave(uri: vscode.Uri) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return;
  }

  const workspacePath = workspaceFolder.uri.fsPath;

  // dispose old service
  findAllFileService(service => service.workspace === workspacePath).forEach(disposeFileService);

  // create new service
  try {
    const configs = await readConfigsFromFile(uri.fsPath);
    configs.forEach(config => createFileService(config, workspacePath));
  } catch (error) {
    reportError(error);
  } finally {
    // The services these watchers were bound to have just been thrown away and
    // built again, so anything autosyncing has to be bound to the new ones.
    await resumeAutosync().catch(error2 =>
      logger.debug(`could not rebind autosync: ${error2.message}`)
    );
    app.remoteExplorer.refresh();
  }
}

async function handleFileSave(uri: vscode.Uri) {
  const fileService = getFileService(uri);
  if (!fileService) {
    return;
  }

  const config = fileService.getConfig();
  const state = autosyncState(fileService);

  // A connection has one writer. While it is this folder, the watcher sends
  // the save and upload-on-save stands down, saying so once. While it is
  // another folder, nothing here would ever send it, so every save that
  // upload-on-save would have sent asks instead - silently keeping it off the
  // server looked like a transfer that failed.
  if (state && !(state.external && config.uploadOnSave)) {
    sayIfPaused(fileService);
    return;
  }

  if (state) {
    await offerUpload(
      uri.fsPath,
      `Upload ${path.basename(uri.fsPath)} to ${connectionLabel(config)}?`,
      `The server is autosynced from ${state.label}, so this save was not sent.`,
      () => uploadFile(uri)
    );
    return;
  }

  if (config.uploadOnSave) {
    const fspath = await realpathSync.native(uri.fsPath);
    uri = vscode.Uri.file(fspath);
    await withConnection(connectionLabel(config), async () => {
      logger.info(`[file-save] ${fspath}`);
      try {
        await uploadFile(uri);
      } catch (error) {
        logger.error(error, `upload ${fspath}`);
        app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
      }
    });
  }
}

/**
 * A copy of the server's file, opened from the temp directory, was saved.
 *
 * No connection covers that folder, so this is the only way a save of it
 * reaches the server - and whether it should is asked every time, as for a
 * save that autosync is standing in the way of.
 */
async function handleRemoteCopySave(file: string, copy: RemoteCopy) {
  const config = copy.service.getConfig();
  const state = autosyncState(copy.service);

  await offerUpload(
    file,
    `Upload ${path.basename(file)} to ${connectionLabel(config)}?`,
    `This is a copy of ${copy.remotePath}; saving it changed only the copy.` +
      (state && state.external
        ? ` The server is autosynced from ${state.label}, which may write over it again.`
        : ''),
    () => uploadFile(remoteCopyContext(file, copy))
  );
}

function remoteCopyContext(file: string, copy: RemoteCopy): FileHandlerContext {
  const config = copy.service.getConfig();

  return {
    fileService: copy.service,
    config,
    target: UResource.from(vscode.Uri.file(file), {
      localBasePath: path.dirname(file),
      remoteBasePath: upath.dirname(copy.remotePath),
      remoteId: copy.service.id,
      remote: { host: config.host, port: config.port },
    }),
  } as FileHandlerContext;
}

/** Files with a question already on screen, so saving again does not stack another. */
const asking = new Set<string>();

/**
 * Asks whether to send a save, and sends it on a yes.
 *
 * Not modal: with auto-save on this comes up on every pause in typing, and a
 * modal would take the keyboard each time. One question per file at a time -
 * saving again while it is open changes nothing, since a yes sends whatever
 * is on disk when it is given.
 */
async function offerUpload(
  file: string,
  message: string,
  detail: string,
  send: () => Promise<void>
): Promise<void> {
  if (asking.has(file)) {
    return;
  }

  asking.add(file);
  let answer: string | undefined;
  try {
    answer = await vscode.window.showWarningMessage(`${message} ${detail}`, UPLOAD, NOT_NOW);
  } finally {
    asking.delete(file);
  }

  if (answer !== UPLOAD) {
    return;
  }

  logger.info(`[file-save] ${file}`);
  try {
    await send();
  } catch (error) {
    logger.error(error, `upload ${file}`);
    app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
  }
}

const UPLOAD = 'Upload';
const NOT_NOW = 'Not Now';

async function downloadOnOpen(uri: vscode.Uri) {
  const fileService = getFileService(uri);
  if (!fileService) {
    return;
  }

  const config = fileService.getConfig();
  if (config.downloadOnOpen) {
    if (config.downloadOnOpen === 'confirm') {
      const isConfirm = await showConfirmMessage('Do you want SFTP to download this file?');
      if (!isConfirm) return;
    }

    const fspath = uri.fsPath;
    await withConnection(connectionLabel(config), async () => {
      logger.info(`[file-open] ${fspath}`);
      try {
        await downloadFile(uri);
      } catch (error) {
        logger.error(error, `download ${fspath}`);
        app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
      }
    });
  }
}

function watchWorkspace({
  onDidSaveFile,
  onDidSaveSftpConfig,
}: {
  onDidSaveFile: (uri: vscode.Uri) => void;
  onDidSaveSftpConfig: (uri: vscode.Uri) => void;
}) {
  if (workspaceWatcher) {
    workspaceWatcher.dispose();
  }

  workspaceWatcher = onDidSaveTextDocument((doc: vscode.TextDocument) => {
    const uri = doc.uri;
    if (!isValidFile(uri)) {
      return;
    }

    // Outside every workspace, so asked about before the check below.
    const copy = remoteCopyAt(uri.fsPath);
    if (copy) {
      handleRemoteCopySave(uri.fsPath, copy);
      return;
    }

    if (!isInWorkspace(uri.fsPath)) {
      return;
    }

    // remove staled cache
    if (app.fsCache.has(uri.fsPath)) {
      app.fsCache.del(uri.fsPath);
    }

    if (isConfigFile(uri)) {
      onDidSaveSftpConfig(uri);
      return;
    }

    onDidSaveFile(uri);
  });
}

function init() {
  onDidOpenTextDocument((doc: vscode.TextDocument) => {
    if (!isValidFile(doc.uri) || !isInWorkspace(doc.uri.fsPath)) {
      return;
    }

    downloadOnOpen(doc.uri);
  });

  watchWorkspace({
    onDidSaveFile: handleFileSave,
    onDidSaveSftpConfig: handleConfigSave,
  });

  closeWatcher = vscode.workspace.onDidCloseTextDocument(doc =>
    forgetRemoteCopy(doc.uri.fsPath)
  );
}

function destory() {
  if (workspaceWatcher) {
    workspaceWatcher.dispose();
  }
  if (closeWatcher) {
    closeWatcher.dispose();
  }
}

export default {
  init,
  destory,
};
