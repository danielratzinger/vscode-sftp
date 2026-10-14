import * as fse from 'fs-extra';
import { Uri, workspace, WorkspaceEdit } from 'vscode';
import { fileOperations, FileSystem, FileType } from '../core';
import createFileHandler, { resourceFor } from './createFileHandler';
import { refreshRemoteExplorer } from './shared';
import logger from '../logger';

export interface RenameOption {
  /** Where the file was, named from either side. */
  originUri: Uri;
  /**
   * Whether the copy on this machine should follow.
   *
   * On for a rename asked for in the Remote Explorer: a download writes and
   * never removes, so leaving the old name here and the new one there means the
   * next download brings back both. Off when the local rename has already
   * happened and the server is only being told about it, which is what
   * `Upload Changed Files` does with a rename git reports.
   */
  renameLocal?: boolean;
  /**
   * Whether a file already sitting at the new name may be written over.
   *
   * Asked of the person before any of this starts, because it is their answer
   * to give - and only ever about a file. A folder in the way is refused
   * earlier: overwriting one means deleting what is inside it.
   */
  overwrite?: boolean;
}

/** What is at a path on the server, or nothing when there is nothing there. */
async function whatIsAt(remoteFs: FileSystem, remotePath: string) {
  try {
    return await remoteFs.lstat(remotePath);
  } catch (error) {
    return null;
  }
}

/**
 * Moves the copy here, through the editor when it will.
 *
 * Moved behind the editor's back, a file that is open looks deleted - its tab
 * struck through - and a new file appears that nothing has open. The editor's
 * own rename takes the open tab with it, unsaved changes and all, so whoever
 * renamed it carries on where they were. It also tells everything listening
 * for renames, including this extension's own `renameFollowing`, which finds
 * the old name already gone from the server and has nothing to ask.
 *
 * Done directly only when the editor declines.
 */
async function moveLocal(from: string, to: string, overwrite: boolean): Promise<void> {
  const edit = new WorkspaceEdit();
  edit.renameFile(Uri.file(from), Uri.file(to), { overwrite });

  if (await workspace.applyEdit(edit)) {
    return;
  }

  logger.debug(`[rename] the editor would not move ${from}; moving it directly`);
  await fse.move(from, to, { overwrite });
}

export const renameRemote = createFileHandler<RenameOption>({
  name: 'rename',
  async handle({ originUri, renameLocal, overwrite }) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const origin = resourceFor(this.fileService, this.config, originUri);

    // Both sides of a rename on the server have to be the server's own paths.
    // The caller knows the file by one name or the other, and which one depends
    // on whether it was asked for in the file explorer or the remote one.
    const from = origin.remoteFsPath;
    const to = this.target.remoteFsPath;

    if (from === to) {
      // Nothing to do, and everything to avoid: the overwrite path below would
      // find something at the target, remove it, and then have nothing left to
      // rename. Which is how a file gets deleted by being renamed to its own
      // name.
      logger.info(`${from} already has that name`);
      return;
    }

    if (overwrite && (this.config as any).openSsh) {
      // The one way to replace a file without a moment where neither name has
      // anything: OpenSSH's own rename, which is a rename(2) and overwrites.
      await remoteFs.renameAtomic(from, to);
    } else {
      try {
        await fileOperations.rename(from, to, remoteFs);
      } catch (error) {
        if (!overwrite) {
          throw error;
        }

        // Not inferred from the failure: a rename can fail for reasons that have
        // nothing to do with the target, and removing something on a guess is how
        // a file gets deleted by a command that was asked to rename one. Only
        // what is demonstrably there is removed, and any other failure is
        // reported as itself.
        const standing = await whatIsAt(remoteFs, to);
        if (!standing) {
          throw error;
        }

        if (standing.type === FileType.Directory) {
          throw new Error(`${to} is a folder, and folders are not written over`);
        }

        // SFTP refuses a rename onto something that exists, so the something has
        // to go first. Not atomic, and there is no way to make it so without the
        // extension above - said here rather than pretended away.
        logger.info(`replacing ${to}, which cannot be done in one step here`);
        await fileOperations.removeFile(to, remoteFs, {});
        await fileOperations.rename(from, to, remoteFs);
      }
    }

    if (!renameLocal) {
      return;
    }

    const localFrom = origin.localFsPath;
    const localTo = this.target.localFsPath;

    if (!(await fse.pathExists(localFrom))) {
      // Nothing downloaded under the old name, so nothing here to follow.
      return;
    }

    try {
      await moveLocal(localFrom, localTo, Boolean(overwrite));
    } catch (error) {
      // The server has already been renamed, so the tree shows that before
      // anything else: a failure throws past `afterHandle`, and the old name
      // would stay on screen for a file that no longer has it.
      refreshRemoteExplorer(this.target, false);

      // Nor can this be swallowed: the two sides now disagree, and only
      // saying so lets anybody put it right.
      throw new Error(
        `renamed on the server, but the copy here could not follow: ` +
          `${error.message}`
      );
    }
  },
  afterHandle() {
    // The folder around it is what changed, whether a file or a folder was
    // renamed, so it is the listing of the parent that is now wrong.
    refreshRemoteExplorer(this.target, false);
  },
});
