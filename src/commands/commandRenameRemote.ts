import { Uri, window } from 'vscode';
import { COMMAND_RENAME_REMOTE } from '../constants';
import { upath } from '../core';
import { handleCtxFromUri, renameRemote } from '../fileHandlers';
import { nameComplaint } from '../core/renameName';
import { showWarningMessage } from '../host';
import { checkCommand } from './abstract/createCommand';
import { uriFromExplorerContextOrEditorContext } from './shared';
import * as fse from 'fs-extra';

/**
 * Renaming a file or folder on the server, and the copy of it here.
 *
 * Both, because a download writes and never removes: renaming only the server's
 * copy leaves the old name sitting here, and the next download brings back both.
 * The prompt says which of the two it is about to do, since whether there is a
 * copy here depends on whether it was ever downloaded.
 */
export default checkCommand({
  id: COMMAND_RENAME_REMOTE,

  async handleCommand(item, items) {
    const target = uriFromExplorerContextOrEditorContext(item, items);
    if (!target) {
      return;
    }

    if (Array.isArray(target) && target.length > 1) {
      // One name for several files is not a rename.
      showWarningMessage('Renaming works on one file or folder at a time.');
      return;
    }

    const origin: Uri = Array.isArray(target) ? target[0] : target;
    const current = upath.basename(origin.path);
    const ctx = handleCtxFromUri(origin);
    const alsoHere = await fse.pathExists(ctx.target.localFsPath);

    const name = await window.showInputBox({
      value: current,
      // The name without its extension, which is what a rename usually changes.
      valueSelection: [0, current.length - upath.extname(current).length],
      prompt: alsoHere
        ? 'New name, on the server and for the copy on this machine'
        : 'New name on the server',
      validateInput: typed => nameComplaint(typed),
    });

    if (name === undefined || name.trim() === current) {
      return;
    }

    const renamed = origin.with({
      path: upath.join(upath.dirname(origin.path), name.trim()),
    });

    await renameRemote(renamed, { originUri: origin, renameLocal: true });
  },
});
