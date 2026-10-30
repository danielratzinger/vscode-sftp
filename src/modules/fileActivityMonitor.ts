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
import * as fse from 'fs-extra';
import {
  autosyncState,
  neverUploaded,
  resumeAutosync,
  sentBySave,
} from './worktreeSync';
import { forgetRemoteCopy, remoteCopyAt, RemoteCopy } from './remoteEdits';
import { downloadFile, uploadFile } from '../fileHandlers';
import { FileHandlerContext } from '../fileHandlers/createFileHandler';
import { refreshIgnoreContext } from './ignoreContext';
import { Candidate, ignoreRulesFor } from '../core/projectIgnore';
import { FileService } from '../core';

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
    refreshIgnoreContext().catch(() => undefined);
  }
}

async function handleFileSave(uri: vscode.Uri) {
  const fileService = getFileService(uri);
  if (!fileService) {
    return;
  }

  const config = fileService.getConfig();
  const state = autosyncState(fileService);

  // A connection has one writer. While it is this folder, a save goes up at
  // once, as upload-on-save always sent it - gitignored files included, since
  // saving one is asking for it - and the watcher, seeing the same write, does
  // not send it again. Without upload-on-save the watcher sends what git keeps
  // when it has settled, as before.
  if (state && !state.external) {
    if (config.uploadOnSave && !neverUploaded(fileService, uri.fsPath)) {
      await uploadOnSave(uri, fileService, mtime => sentBySave(uri.fsPath, mtime));
    }
    return;
  }

  // While it is another folder, nothing here would ever send it, so every save
  // that upload-on-save would have sent asks instead - silently keeping it off
  // the server looked like a transfer that failed.
  if (state && !config.uploadOnSave) {
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
    await uploadOnSave(uri, fileService);
  }
}

/**
 * Sends a saved file. `sent` hears the modification time of what went up,
 * read before sending, so a write made during the upload is not mistaken for
 * the one that was sent.
 */
async function uploadOnSave(
  uri: vscode.Uri,
  fileService: FileService,
  sent?: (mtime: number) => void
): Promise<void> {
  const config: any = fileService.getConfig();
  const fspath = await realpathSync.native(uri.fsPath);
  const target = vscode.Uri.file(fspath);

  // What the project's ignore files leave out is asked about every time,
  // rather than sent or dropped: saving one is often meant, and as often a
  // build output or a local `.env` that should never reach the server. What
  // the connection's own `ignore` names is left out as it always was.
  const excludedBy = await excludedFromDeploy(fileService, fspath);
  if (excludedBy) {
    await offerUpload(
      fspath,
      `Upload ${path.basename(fspath)} to ${connectionLabel(config)}?`,
      `${excludedBy} excludes it from uploads.`,
      async () => {
        const { mtimeMs } = await fse.lstat(fspath);
        await uploadFile(target);
        if (sent) {
          sent(mtimeMs);
        }
      }
    );
    return;
  }

  await withConnection(connectionLabel(config), async () => {
    logger.info(`[file-save] ${fspath}`);
    try {
      const { mtimeMs } = await fse.lstat(fspath);
      await uploadFile(target);
      if (sent) {
        sent(mtimeMs);
      }
    } catch (error) {
      logger.error(error, `upload ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  });
}

/**
 * Which ignore file leaves a saved file out, if one does - and only when the
 * connection's own `ignore` does not, since that one is never asked about.
 */
async function excludedFromDeploy(
  fileService: FileService,
  fspath: string
): Promise<string | undefined> {
  const ignore = fileService.getConfig().ignore;
  if (ignore && ignore(fspath)) {
    return undefined;
  }

  try {
    const rules = await ignoreRulesFor(fileService.baseDir);
    if (!rules) {
      return undefined;
    }

    // The folders above count: a file in an ignored folder is ignored with it.
    const chain: Candidate[] = [];
    let at = path.dirname(fspath);
    while (at.length > fileService.baseDir.length && at.indexOf(fileService.baseDir) === 0) {
      chain.unshift({ path: at, dir: true });
      at = path.dirname(at);
    }
    chain.push({ path: fspath, dir: false });

    const ignored = await rules.ignoredAmong(chain);
    return ignored.size > 0 ? rules.sources.join(' or ') : undefined;
  } catch (error) {
    logger.debug(`could not ask the ignore files about ${fspath}: ${error.message}`);
    return undefined;
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
