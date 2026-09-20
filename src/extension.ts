'use strict';
// First, and it has to stay first: it patches `util` for ssh2, which takes its
// copy of what is patched the moment it is required - which happens while the
// imports below are still being evaluated. See `core/nodeCompat`.
import './core/nodeCompat';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import app from './app';
import initCommands from './initCommands';
import initCredentials from './modules/credentials';
import { initMcp } from './mcp';
import { initReplacedFiles } from './modules/replacedFiles';
import { checkForOtherSftpExtensions } from './modules/otherSftpExtensions';
import { initPasswordExposure } from './modules/passwordExposure';
import { initFtpsUpgrade } from './modules/ftpsUpgrade';
import {
  initWorktreeSync,
  onDidChangeAutosync,
  resumeAutosync,
} from './modules/worktreeSync';
import initAutosyncDecoration from './modules/autosyncDecoration';
import { initAutosyncBackup } from './modules/autosyncBackup';
import { initHostVerification } from './modules/hostVerification';
import { reportError } from './helper';
import fileActivityMonitor from './modules/fileActivityMonitor';
import { tryLoadConfigs } from './modules/config';
import { getAllFileService, createFileService, disposeFileService } from './modules/serviceManager';
import { getWorkspaceFolders, setContextValue } from './host';
import RemoteExplorer from './modules/remoteExplorer';

async function setupWorkspaceFolder(dir) {
  const configs = await tryLoadConfigs(dir);
  configs.forEach(config => {
    createFileService(config, dir);
  });
}

function setup(workspaceFolders: readonly vscode.WorkspaceFolder[]) {
  fileActivityMonitor.init();
  const pendingInits = workspaceFolders.map(folder => setupWorkspaceFolder(folder.uri.fsPath));

  return Promise.all(pendingInits);
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
  // Before anything can connect, so a stored password is available on the
  // first attempt rather than after a stray prompt.
  initCredentials(context);

  // Before anything can connect: a connection made before this is in place is
  // a connection that checked nothing.
  try {
    initHostVerification(context);
  } catch (error) {
    reportError(error, 'initHostVerification');
  }

  try {
    initCommands(context);
  } catch (error) {
    reportError(error, 'initCommands');
  }

  try {
    initReplacedFiles(context);
  } catch (error) {
    reportError(error, 'initReplacedFiles');
  }

  try {
    initFtpsUpgrade(context);
    initAutosyncBackup(context);
    initWorktreeSync(context);
    initAutosyncDecoration(context);
    // The badge and the connection's description both say what is syncing, and
    // neither notices on its own that it has changed.
    context.subscriptions.push(
      onDidChangeAutosync(() => {
        if (app.remoteExplorer) {
          app.remoteExplorer.refresh();
        }
      })
    );
  } catch (error) {
    reportError(error, 'initFtpsUpgrade');
  }

  try {
    initPasswordExposure(context);
  } catch (error) {
    reportError(error, 'initPasswordExposure');
  }

  try {
    checkForOtherSftpExtensions(context);
  } catch (error) {
    reportError(error, 'checkForOtherSftpExtensions');
  }

  try {
    initMcp(context);
  } catch (error) {
    reportError(error, 'initMcp');
  }

  const workspaceFolders = getWorkspaceFolders();
  if (!workspaceFolders) {
    return;
  }

  setContextValue('enabled', true);
  app.sftpBarItem.show();
  app.state.subscribe(_ => {
    const currentText = app.sftpBarItem.getText();
    // current is showing profile
    if (currentText.startsWith('SFTP')) {
      app.sftpBarItem.reset();
    }
    if (app.remoteExplorer) {
      app.remoteExplorer.refresh();
    }
  });
  try {
    await setup(workspaceFolders);
    app.remoteExplorer = new RemoteExplorer(context);

    // Only now do the connections exist. Anything that was syncing when this
    // window last closed picks up here - including whatever changed in its
    // folder while nothing was watching.
    await resumeAutosync();
  } catch (error) {
    reportError(error);
  }
}

export function deactivate() {
  fileActivityMonitor.destory();
  getAllFileService().forEach(disposeFileService);
}
