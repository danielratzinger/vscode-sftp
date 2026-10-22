import * as vscode from 'vscode';
import { registerCommand } from '../../host';
import {
  COMMAND_REMOTEEXPLORER_REFRESH,
  COMMAND_REMOTEEXPLORER_REFRESH_ACTIVE_FILE,
  COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
} from '../../constants';
import { UResource } from '../../core';
import { toRemotePath } from '../../helper';
import { REMOTE_SCHEME } from '../../constants';
import { getFileService } from '../serviceManager';
import RemoteTreeDataProvider, { ExplorerItem } from './treeDataProvider';
import { loginGuard } from '../../core/remoteFs';
import { loginKey } from '../../core/loginGuard';

export default class RemoteExplorer {
  private _explorerView: vscode.TreeView<ExplorerItem>;
  private _treeDataProvider: RemoteTreeDataProvider;

  constructor(context: vscode.ExtensionContext) {
    this._treeDataProvider = new RemoteTreeDataProvider();
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, this._treeDataProvider)
    );

    this._explorerView = vscode.window.createTreeView('remoteExplorer', {
      showCollapseAll: true,
      treeDataProvider: this._treeDataProvider,
      canSelectMany: true,
    });

    // Opening a connection is asking for it: if its login was paused after
    // the server refused the password, this is the explicit attempt the pause
    // waits for. The tree may already have asked and been told no, so it is
    // asked again once the permission is there.
    context.subscriptions.push(
      this._explorerView.onDidExpandElement(event => {
        if (this._askToLogIn(event.element)) {
          this.refresh(event.element);
        }
      })
    );

    registerCommand(context, COMMAND_REMOTEEXPLORER_REFRESH, () => this._refreshSelection());
    registerCommand(context, COMMAND_REMOTEEXPLORER_REFRESH_ACTIVE_FILE, () => this._refreshActiveRemoteFile());
    registerCommand(context, COMMAND_REMOTEEXPLORER_VIEW_CONTENT, (item: ExplorerItem) =>
      this._treeDataProvider.showItem(item)
    );
  }

  refresh(item?: ExplorerItem) {
    if (item && !UResource.isRemote(item.resource.uri)) {
      const uri = item.resource.uri;
      const fileService = getFileService(uri);
      if (!fileService) {
        if (uri.toString(true) == "file:///${command:sftp.sync.remoteToLocal}") {
          throw '';
        } else {
          throw new Error(`Config Not Found. (${uri.toString(true)})`);
        }
      }
      const config = fileService.getConfig();
      const localPath = item.resource.fsPath;
      const remotePath = toRemotePath(localPath, config.context, config.remotePath);
      item.resource = UResource.makeResource({
        remote: {
          host: config.host,
          port: config.port,
        },
        fsPath: remotePath,
        remoteId: fileService.id,
      });
    }

    this._treeDataProvider.refresh(item);
  }

  reveal(item: ExplorerItem): Thenable<void> {
    return item ? this._explorerView.reveal(item) : Promise.resolve();
  }

  findRoot(remoteUri: vscode.Uri) {
    return this._treeDataProvider.findRoot(remoteUri);
  }

  private _refreshSelection() {
    if (this._explorerView.selection.length) {
      this._explorerView.selection.forEach(item => {
        this._askToLogIn(item);
        this.refresh(item);
      });
    } else {
      this._treeDataProvider
        .getChildren()
        .then(roots => roots.forEach(root => this._askToLogIn(root)))
        .catch(() => undefined)
        .then(() => this.refresh());
    }
  }

  /**
   * Counts as someone asking to log in to the item's connection - which is
   * what the pause after a refused password waits for. True when the login
   * was paused, so whoever called knows a fresh look is worth taking.
   */
  private _askToLogIn(item: ExplorerItem | undefined): boolean {
    if (!item) {
      return false;
    }
    const root = this._treeDataProvider.findRoot(item.resource.uri);
    if (!root) {
      return false;
    }
    const key = loginKey(root.explorerContext.config as any);
    loginGuard.askFor(key);
    return loginGuard.isPaused(key);
  }

  private _refreshActiveRemoteFile() {
    const focusedEditor = vscode.window.activeTextEditor;
    if (focusedEditor) {

      const remoteFileUri = focusedEditor.document.uri;
      const root = this._treeDataProvider.findRoot(remoteFileUri);
      const incompleteResource = UResource.makeResource(remoteFileUri);

      if (!root) {
        return;
      }
      const remoteFileItem = {
        resource: UResource.updateResource(root.resource, {
          remotePath: incompleteResource.fsPath
        }),
        isDirectory: false
      };

      this.refresh(remoteFileItem);
    }
    
  }
}
