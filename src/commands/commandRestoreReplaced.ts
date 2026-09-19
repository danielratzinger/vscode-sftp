import * as vscode from 'vscode';
import * as path from 'path';
import { COMMAND_RESTORE_REPLACED } from '../constants';
import { showInformationMessage, showWarningMessage, diffFiles } from '../host';
import { getActiveTextEditor, getWorkspaceFolders } from '../host';
import { Backup } from '../core/overwriteBackup';
import {
  isEnabled,
  restore,
  versionsOf,
  connectionsHolding,
} from '../modules/replacedFiles';
import { checkCommand } from './abstract/createCommand';

interface VersionPick extends vscode.QuickPickItem {
  backup: Backup;
  connectionId: string;
}

function describeSize(bytes: number): string {
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
}

/**
 * A copy kept is only worth keeping if it can be got back, and the moment
 * someone wants it is the moment they have just realised what a download took
 * with it. So: pick the file, see the versions, look at one before committing
 * to it.
 */
export default checkCommand({
  id: COMMAND_RESTORE_REPLACED,

  async handleCommand() {
    if (!isEnabled()) {
      showInformationMessage(
        'Copies of replaced files are turned off (sftp.keepReplacedFiles).'
      );
      return;
    }

    const editor = getActiveTextEditor();
    const folders = getWorkspaceFolders();
    const active = editor ? editor.document.uri.fsPath : undefined;

    const localPath = active
      ? active
      : (
          await vscode.window.showOpenDialog({
            canSelectMany: false,
            defaultUri: folders && folders.length ? folders[0].uri : undefined,
            openLabel: 'Show earlier copies',
          })
        )?.[0]?.fsPath;

    if (!localPath) {
      return;
    }

    const picks: VersionPick[] = [];
    for (const connectionId of await connectionsHolding()) {
      const versions = await versionsOf(connectionId, localPath);
      versions.forEach(backup =>
        picks.push({
          backup,
          connectionId,
          label: new Date(backup.timestamp).toLocaleString(),
          description: describeSize(backup.size),
          detail: 'Replaced by a download',
        })
      );
    }

    if (picks.length === 0) {
      showInformationMessage(
        `No earlier copies of ${path.basename(localPath)}. Copies are kept ` +
          'when a download writes over a file that differs from the server’s.'
      );
      return;
    }

    picks.sort((a, b) => b.backup.timestamp - a.backup.timestamp);

    const chosen = await vscode.window.showQuickPick(picks, {
      placeHolder: `Earlier copies of ${path.basename(localPath)}`,
    });
    if (!chosen) {
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `Restore ${path.basename(localPath)} from ${chosen.label}?`,
      { modal: true },
      'Restore',
      'Compare'
    );

    if (answer === 'Compare') {
      diffFiles(
        chosen.backup.path,
        localPath,
        `${path.basename(localPath)} (${chosen.label}) ↔ now`
      );
      return;
    }

    if (answer !== 'Restore') {
      return;
    }

    try {
      // What it replaces is kept first, so restoring the wrong one is not the
      // end of the story.
      await restore(chosen.connectionId, chosen.backup);
      showInformationMessage(
        `Restored ${path.basename(localPath)} from ${chosen.label}.`
      );
    } catch (error) {
      showWarningMessage(`Could not restore that copy: ${error.message}`);
    }
  },
});
