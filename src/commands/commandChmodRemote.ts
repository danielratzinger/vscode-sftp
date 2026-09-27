import { Uri, window } from 'vscode';
import { COMMAND_CHMOD_REMOTE } from '../constants';
import { upath } from '../core';
import { chmodRemote, handleCtxFromUri } from '../fileHandlers';
import { formatMode, modeComplaint, parseMode } from '../core/permissionMode';
import { reportError } from '../helper';
import { checkCommand } from './abstract/createCommand';
import { uriFromExplorerContextOrEditorContext } from './shared';

/**
 * Changing what a file or folder on the server may be done with.
 *
 * The mode it already has is shown as the answer, so the question can be read
 * before it is answered - a permission nobody remembers is the usual reason for
 * opening this at all. Several at once is allowed, because one mode over a
 * selection is a thing somebody means, unlike one name.
 *
 * Nothing recursive: files and folders want different modes, so a single mode
 * applied all the way down is almost always wrong. `755` over a folder of PHP
 * makes every one of them executable.
 */
export default checkCommand({
  id: COMMAND_CHMOD_REMOTE,

  async handleCommand(item, items) {
    const target = uriFromExplorerContextOrEditorContext(item, items);
    if (!target) {
      return;
    }

    const targets: Uri[] = Array.isArray(target) ? target : [target];
    const current = targets.length === 1 ? await modeOf(targets[0]) : undefined;

    const typed = await window.showInputBox({
      value: current,
      prompt:
        targets.length === 1
          ? `Permissions for '${upath.basename(targets[0].path)}', as octal digits`
          : `Permissions for ${targets.length} items, as octal digits`,
      validateInput: text => modeComplaint(text),
    });

    if (typed === undefined || (current !== undefined && typed.trim() === current)) {
      return;
    }

    const mode = parseMode(typed);

    // One at a time rather than all at once: a server that refuses one should
    // not take the rest with it, and each failure names its own file.
    for (const uri of targets) {
      try {
        await chmodRemote(uri, { mode });
      } catch (error) {
        reportError(error);
      }
    }
  },
});

/** The mode a file on the server has now, or nothing when it will not say. */
async function modeOf(uri: Uri): Promise<string | undefined> {
  try {
    const ctx = handleCtxFromUri(uri);
    const remoteFs = await ctx.fileService.getRemoteFileSystem(ctx.config);
    const stat = await remoteFs.lstat(ctx.target.remoteFsPath);
    return formatMode(stat.mode);
  } catch (error) {
    // An FTP server that reports no mode is not a reason to refuse the command;
    // it only means there is nothing to fill in.
    return undefined;
  }
}
