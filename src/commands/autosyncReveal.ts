import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import { executeCommand, showWarningMessage } from '../host';
import connectionLabel from '../core/connectionLabel';
import { autosyncState } from '../modules/worktreeSync';
import { whichConnection } from './commandAutosyncWorktree';
import { checkCommand } from './abstract/createCommand';

/**
 * Getting to the folder that is actually being deployed.
 *
 * When a connection autosyncs a checkout this window does not have open, that
 * folder is where the work is happening and nothing on screen will take you
 * there: the file explorer shows this window's project and the Remote Explorer
 * shows the server. The branch name is the only trace of it, and a branch name
 * is not a path.
 *
 * Offered only while a connection is syncing from somewhere else. On its own
 * folder these would be two more ways to open the folder already open.
 *
 * Not in this file: the commands themselves. Each is its own module because
 * only a module's default export is registered, and a menu entry shows its
 * command's title - so the file manager needs one title per platform.
 */
export async function autosyncedFolder(
  ...args: any[]
): Promise<string | undefined> {
  const service = await whichConnection(...args);
  if (!service) {
    return undefined;
  }

  const state = autosyncState(service);
  if (!state || !state.external) {
    showWarningMessage(
      `${connectionLabel(service.getConfig() as any)} is not autosyncing a ` +
        'folder from anywhere else.'
    );
    return undefined;
  }

  // A worktree removed by hand leaves everything else in place, so the folder
  // may simply not be there any more.
  if (!(await fse.pathExists(state.root))) {
    showWarningMessage(`${state.root} is not there any more.`);
    return undefined;
  }

  return state.root;
}

/** A command that opens the autosynced folder with one of the editor's own. */
export function revealAutosyncWith(id: string, editorCommand: string) {
  return checkCommand({
    id,

    async handleCommand(...args: any[]) {
      const folder = await autosyncedFolder(...args);
      if (folder) {
        await executeCommand(editorCommand, vscode.Uri.file(folder));
      }
    },
  });
}
