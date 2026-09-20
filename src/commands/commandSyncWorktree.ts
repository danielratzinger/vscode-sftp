import * as vscode from 'vscode';
import { COMMAND_SYNC_WORKTREE } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { getAllFileService, getFileService } from '../modules/serviceManager';
import { chooseWorktree } from '../modules/worktreeSync';
import { uriFromExplorerContextOrEditorContext } from './shared';
import { getActiveTextEditor } from '../host';
import connectionLabel from '../core/connectionLabel';
import { FileService } from '../core';

/**
 * Which connection a worktree command is about.
 *
 * Nearly always the context knows: a folder right-clicked in the file
 * explorer, a connection right-clicked in the Remote Explorer, the file being
 * edited. Asking in any of those cases is asking somebody to repeat
 * themselves. The question is for the one case that cannot be answered - the
 * palette, with nothing open and more than one connection configured.
 */
export async function whichConnection(
  ...args: any[]
): Promise<FileService | undefined> {
  const fromContext = uriFromExplorerContextOrEditorContext(args[0], args[1]);
  const clicked = Array.isArray(fromContext) ? fromContext[0] : fromContext;

  if (clicked) {
    const service = getFileService(clicked);
    if (service) {
      return service;
    }
  }

  const editing = getActiveTextEditor();
  if (editing && editing.document) {
    const service = getFileService(editing.document.uri);
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

  async handleCommand(...args: any[]) {
    const service = await whichConnection(...args);
    if (service) {
      await chooseWorktree(service);
    }
  },
});
