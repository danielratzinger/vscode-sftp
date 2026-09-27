import { Uri, window } from 'vscode';
import { COMMAND_RENAME_REMOTE } from '../constants';
import { upath } from '../core';
import { FileType } from '../core';
import { handleCtxFromUri, renameRemote } from '../fileHandlers';
import {
  CANCEL,
  Choice,
  Occupant,
  nameComplaint,
  whatToAsk,
} from '../core/renameName';
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

    const wanted = name.trim();
    const renamed = origin.with({
      path: upath.join(upath.dirname(origin.path), wanted),
    });

    // Looked at before anything moves. Finding out halfway leaves the server
    // renamed and this machine not, which is the one outcome worth a round trip
    // to avoid.
    const chosen = await decide(renamed, wanted);
    if (!chosen) {
      return;
    }

    await renameRemote(renamed, { originUri: origin, ...chosen });
  },
});

/** What is at a path on the server, as far as it will say. */
async function onServer(uri: Uri): Promise<Occupant> {
  const ctx = handleCtxFromUri(uri);
  const remoteFs = await ctx.fileService.getRemoteFileSystem(ctx.config);

  try {
    const stat = await remoteFs.lstat(ctx.target.remoteFsPath);
    return stat.type === FileType.Directory ? 'directory' : 'file';
  } catch (error) {
    // Not there is the ordinary answer, and the only one that matters here.
    return 'nothing';
  }
}

/** What is at a path on this machine. */
async function onThisMachine(uri: Uri): Promise<Occupant> {
  const ctx = handleCtxFromUri(uri);
  const local = ctx.target.localFsPath;

  if (!(await fse.pathExists(local))) {
    return 'nothing';
  }

  return (await fse.stat(local)).isDirectory() ? 'directory' : 'file';
}

/**
 * Whether to go ahead, and on what terms - asking only when there is something
 * to ask.
 */
async function decide(renamed: Uri, name: string): Promise<Choice | undefined> {
  const ask = whatToAsk(
    {
      remote: await onServer(renamed),
      local: await onThisMachine(renamed),
    },
    name
  );

  if (ask.refuse) {
    showWarningMessage(ask.refuse);
    return undefined;
  }

  if (ask.goAhead) {
    return ask.goAhead;
  }

  const answer = await showWarningMessage(ask.message!, ...ask.choices!);
  if (!answer || answer === CANCEL) {
    return undefined;
  }

  return ask.meaning![answer];
}
