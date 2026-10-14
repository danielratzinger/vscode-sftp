import * as vscode from 'vscode';
import * as path from 'path';
import { COMMAND_SHOW_HISTORY } from '../constants';
import { getActiveTextEditor, showInformationMessage } from '../host';
import { getFileService } from '../modules/serviceManager';
import {
  connectionIdOf,
  optionFor as serverStoreFor,
  sessionsFor,
} from '../modules/autosyncBackup';
import { optionFor as localStoreFor, versionsOf } from '../modules/replacedFiles';
import { resourceFor } from '../fileHandlers/createFileHandler';
import { connectionFolder, copiesOf, KeptCopy } from '../core/historyCopies';
import { whichConnection } from './commandAutosyncWorktree';
import { uriFromExplorerContextOrEditorContext } from './shared';
import { checkCommand } from './abstract/createCommand';

/**
 * The earlier versions of a file, shown where they are: in Finder.
 *
 * The editor's own Timeline would be the place for them, but adding to it is
 * not something an installed extension may do yet - the API is still a
 * proposal, open only to the editor's built-in extensions. Until it is, the
 * copies are opened where they live, which is plain files in plain folders.
 *
 * One copy is shown selected in its folder. Several are offered newest first,
 * since each session keeps its copy in a folder of its own. A file with none -
 * or no file at all, from the palette - opens the connection's folder, where
 * every session is, by date.
 */

interface CopyPick extends vscode.QuickPickItem {
  copy?: KeptCopy;
  folder?: string;
}

function describe(copy: KeptCopy): string {
  return copy.kind === 'server'
    ? "the server's copy, kept before autosync wrote over it"
    : "this machine's copy, kept before a download wrote over it";
}

async function show(where: string, isFolder: boolean): Promise<void> {
  // A file is shown selected in its folder; a folder is opened.
  if (isFolder) {
    await vscode.env.openExternal(vscode.Uri.file(where));
  } else {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(where));
  }
}

export default checkCommand({
  id: COMMAND_SHOW_HISTORY,

  async handleCommand(...args: any[]) {
    const fromContext = uriFromExplorerContextOrEditorContext(args[0], args[1]);
    let uri = Array.isArray(fromContext) ? fromContext[0] : fromContext;

    if (!uri) {
      const editing = getActiveTextEditor();
      uri = editing && editing.document ? editing.document.uri : undefined;
    }

    const service = (uri && getFileService(uri)) || (await whichConnection());
    if (!service) {
      return;
    }

    const config = service.getConfig() as any;
    const id = connectionIdOf(service);
    const stores = [
      { root: serverStoreFor(id).root, connectionId: id },
      { root: localStoreFor(id).root, connectionId: id },
    ];

    let copies: KeptCopy[] = [];
    let name = '';
    const target = uri && getFileService(uri) === service
      ? resourceFor(service, config, uri)
      : undefined;
    // The connection itself, right-clicked in the Remote Explorer, is a
    // request for its folder, not for a file's history.
    if (target && target.remoteFsPath !== config.remotePath) {
      name = path.basename(target.remoteFsPath);
      copies = await copiesOf({
        remoteRoot: stores[0].root,
        connectionId: id,
        sessions: await sessionsFor(service),
        remotePath: target.remoteFsPath,
        replaced: await versionsOf(id, target.localFsPath),
      });
    }

    const folder = await connectionFolder(stores);

    if (copies.length === 0) {
      if (!folder) {
        showInformationMessage(
          `Nothing kept for ${config.name || config.host} yet. Copies are made ` +
            'when autosync writes over a file the server has, and when a download ' +
            'writes over one here.'
        );
        return;
      }

      if (name) {
        showInformationMessage(
          `No earlier version of ${name} has been kept. Opening the folder ` +
            'with everything kept for this connection.'
        );
      }
      await show(folder, true);
      return;
    }

    if (copies.length === 1) {
      await show(copies[0].path, false);
      return;
    }

    const picks: CopyPick[] = copies.map(copy => ({
      label: new Date(copy.when).toLocaleString(),
      description: describe(copy),
      copy,
    }));
    if (folder) {
      picks.push({
        label: 'Everything kept for this connection',
        description: folder,
        folder,
      });
    }

    const chosen = await vscode.window.showQuickPick(picks, {
      placeHolder: `${copies.length} earlier versions of ${name} - which one to show in Finder?`,
    });
    if (!chosen) {
      return;
    }

    await show(chosen.copy ? chosen.copy.path : chosen.folder!, !chosen.copy);
  },
});
