import * as vscode from 'vscode';
import { COMMAND_REMOVE_IGNORED } from '../constants';
import { ignoredOnRemote, looking, pickAndRemove, rulesOf } from '../modules/remoteCleanup';
import { checkFileCommand } from './abstract/createCommand';
import { selectFolderFallbackToConfigContext } from './shared';

/** What the ignore files say should not be on the server, and is. Ticked to start with. */
export default checkFileCommand({
  id: COMMAND_REMOVE_IGNORED,
  getFileTarget: selectFolderFallbackToConfigContext,

  async handleFile(ctx) {
    const rules = await rulesOf(ctx);
    if (!rules) {
      vscode.window.showInformationMessage(
        'There is no .gitignore, .git-ftp-ignore or "ignore" in sftp.json here, so nothing counts as ignored.'
      );
      return;
    }

    const found = await looking(ctx, 'Looking for ignored files on the server', walk =>
      ignoredOnRemote(walk, rules)
    );
    if (found === undefined) {
      return;
    }
    if (found.length === 0) {
      vscode.window.showInformationMessage(
        `Nothing on the server that ${rules.sources.join(', ')} exclude${rules.sources.length === 1 ? 's' : ''}.`
      );
      return;
    }

    await pickAndRemove(ctx, found, {
      title: `Ignored by ${rules.sources.join(', ')}`,
      ticked: true,
    });
  },
});
