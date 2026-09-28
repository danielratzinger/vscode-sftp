import * as fse from 'fs-extra';
import * as path from 'path';
import { Uri, window } from 'vscode';
import { COMMAND_RENAME_REMOTE } from '../constants';
import { FileType, UResource, upath } from '../core';
import { FileHandlerContext, handleCtxFromUri, renameRemote } from '../fileHandlers';
import {
  CANCEL,
  Choice,
  Occupant,
  Sameness,
  isSameFile,
  nameComplaint,
  renamedPath,
  whatToAsk,
} from '../core/renameName';
import { showWarningMessage } from '../host';
import { checkCommand } from './abstract/createCommand';
import { uriFromExplorerContextOrEditorContext } from './shared';

/**
 * Renaming a file or folder on the server, and the copy of it here.
 *
 * Both, because a download writes and never removes: renaming only the server's
 * copy leaves the old name sitting here, and the next download brings back both.
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
    const ctx = handleCtxFromUri(origin);
    const current = upath.basename(ctx.target.remoteFsPath);
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

    const renamed = renamedUri(origin, ctx, name);
    const chosen = await decide(ctx, renamed, name.trim(), alsoHere);
    if (!chosen) {
      return;
    }

    await renameRemote(renamed, { originUri: origin, ...chosen });
  },
});

/**
 * The same file under a new name, named the way the original was named.
 *
 * A remote uri keeps the server's path in its query string and an encoded copy
 * of it in `uri.path`, so replacing the path alone leaves the real one pointing
 * at the file being renamed - and a rename whose two sides are the same path
 * removed the file instead of renaming it. `updateResource` changes both.
 */
function renamedUri(origin: Uri, ctx: FileHandlerContext, name: string): Uri {
  if (UResource.isRemote(origin)) {
    return UResource.updateResource(UResource.makeResource(ctx.target.remoteUri), {
      remotePath: renamedPath(ctx.target.remoteFsPath, name),
    }).uri;
  }

  return Uri.file(path.join(path.dirname(ctx.target.localFsPath), name.trim()));
}

/** What is at a path on the server, and how big and how old it is. */
async function onServer(
  ctx: FileHandlerContext,
  remotePath: string
): Promise<{ occupant: Occupant; stat: Sameness | null }> {
  try {
    const remoteFs = await ctx.fileService.getRemoteFileSystem(ctx.config);
    const stat = await remoteFs.lstat(remotePath);
    return {
      occupant: stat.type === FileType.Directory ? 'directory' : 'file',
      stat: { size: stat.size, mtime: stat.mtime },
    };
  } catch (error) {
    // Not there is the ordinary answer, and the only one that matters here.
    return { occupant: 'nothing', stat: null };
  }
}

/** The same, on this machine. */
async function onThisMachine(
  localPath: string
): Promise<{ occupant: Occupant; stat: Sameness | null }> {
  try {
    const stat = await fse.stat(localPath);
    return {
      occupant: stat.isDirectory() ? 'directory' : 'file',
      stat: { size: stat.size, mtime: stat.mtime.getTime() },
    };
  } catch (error) {
    return { occupant: 'nothing', stat: null };
  }
}

/**
 * Whether to go ahead, and on what terms - asking only when there is something
 * worth asking.
 *
 * Two things that look like a clash and are not. A copy on this machine at the
 * new name matters only if there is a copy at the old name to move onto it;
 * with nothing to move, nothing here is touched either way. And a file that is
 * byte for byte the one being put there is not in the way of anything.
 */
async function decide(
  ctx: FileHandlerContext,
  renamed: Uri,
  name: string,
  hasLocalSource: boolean
): Promise<Choice | undefined> {
  const renamedCtx = handleCtxFromUri(renamed);

  const [fromServer, toServer, fromHere, toHere] = await Promise.all([
    onServer(ctx, ctx.target.remoteFsPath),
    onServer(ctx, renamedCtx.target.remoteFsPath),
    onThisMachine(ctx.target.localFsPath),
    onThisMachine(renamedCtx.target.localFsPath),
  ]);

  const inTheWay = (
    there: { occupant: Occupant; stat: Sameness | null },
    moving: { stat: Sameness | null }
  ): Occupant =>
    there.occupant === 'file' && isSameFile(there.stat, moving.stat)
      ? 'nothing'
      : there.occupant;

  const ask = whatToAsk(
    {
      remote: inTheWay(toServer, fromServer),
      local: hasLocalSource ? inTheWay(toHere, fromHere) : 'nothing',
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
