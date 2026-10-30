import * as vscode from 'vscode';
import { COMMAND_TIDY_REMOTE } from '../constants';
import { looking, missingLocally, pickAndRemove } from '../modules/remoteCleanup';
import { checkFileCommand } from './abstract/createCommand';
import { selectFolderFallbackToConfigContext } from './shared';

/** What the server has and this machine does not. Nothing ticked to start with. */
export default checkFileCommand({
  id: COMMAND_TIDY_REMOTE,
  getFileTarget: selectFolderFallbackToConfigContext,

  async handleFile(ctx) {
    const found = await looking(ctx, 'Looking for files only the server has', missingLocally);
    if (found === undefined) {
      return;
    }
    if (found.length === 0) {
      vscode.window.showInformationMessage('Everything on the server is here too.');
      return;
    }

    await pickAndRemove(ctx, found, { title: 'Only on the server', ticked: false });
  },
});
