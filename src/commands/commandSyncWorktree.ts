import * as vscode from 'vscode';
import { COMMAND_SYNC_WORKTREE } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { getAllFileService, getFileService } from '../modules/serviceManager';
import { chooseWorktree } from '../modules/worktreeSync';
import connectionLabel from '../core/connectionLabel';
import { FileService } from '../core';

/**
 * Which checkout a connection deploys from.
 *
 * Reached from a connection in the Remote Explorer, where the answer is
 * obvious, or from the palette, where it is whichever connection there is -
 * and a choice when there is more than one.
 */
async function whichConnection(hint: any): Promise<FileService | undefined> {
  if (hint && hint.resource && hint.resource.uri) {
    const service = getFileService(hint.resource.uri);
    if (service) {
      return service;
    }
  }

  const all = getAllFileService();
  if (all.length === 0) {
    vscode.window.showInformationMessage('No SFTP connection is open.');
    return undefined;
  }
  if (all.length === 1) {
    return all[0];
  }

  const picked = await vscode.window.showQuickPick(
    all.map(service => ({
      label: connectionLabel(service.getConfig() as any) || service.name,
      description: service.baseDir,
      service,
    })),
    { placeHolder: 'Which connection?' }
  );

  return picked && picked.service;
}

export default checkCommand({
  id: COMMAND_SYNC_WORKTREE,

  async handleCommand(hint: any) {
    const service = await whichConnection(hint);
    if (service) {
      await chooseWorktree(service);
    }
  },
});
