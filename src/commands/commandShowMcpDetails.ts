import * as vscode from 'vscode';
import { COMMAND_SHOW_MCP_DETAILS } from '../constants';
import { connectionDetails } from '../mcp';
import { checkCommand } from './abstract/createCommand';

/**
 * Settings hold the knobs; a setting description is static markdown and cannot
 * show a real path or a real port. The details belong here.
 */
export default checkCommand({
  id: COMMAND_SHOW_MCP_DETAILS,

  async handleCommand() {
    const document = await vscode.workspace.openTextDocument({
      content: connectionDetails(),
      language: 'markdown',
    });

    await vscode.window.showTextDocument(document, { preview: false });
  },
});
