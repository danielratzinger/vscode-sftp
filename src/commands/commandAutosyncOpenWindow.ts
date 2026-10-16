import * as vscode from 'vscode';
import { COMMAND_AUTOSYNC_OPEN_WINDOW } from '../constants';
import { executeCommand } from '../host';
import { autosyncedFolder } from './autosyncReveal';
import { checkCommand } from './abstract/createCommand';

/**
 * The folder being deployed, in a window of its own.
 *
 * Not this window switched over to it: the checkout an agent works in usually
 * has no `sftp.json` - it holds a password and is kept out of git - so a
 * window moved there would lose the connection, and moving a window reloads
 * it, interrupting every other connection it is syncing. A second window has
 * none of that, and a save made in it is deployed like any other change in
 * that folder, because that folder is what autosync is watching.
 *
 * Offered only while a connection syncs from somewhere other than this
 * window's own folder.
 */
export default checkCommand({
  id: COMMAND_AUTOSYNC_OPEN_WINDOW,

  async handleCommand(...args: any[]) {
    const folder = await autosyncedFolder(...args);
    if (folder) {
      await executeCommand('vscode.openFolder', vscode.Uri.file(folder), {
        forceNewWindow: true,
      });
    }
  },
});
