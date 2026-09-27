import * as fse from 'fs-extra';
import { Uri } from 'vscode';
import { fileOperations } from '../core';
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
}

export const renameRemote = createFileHandler<RenameOption>({
  name: 'rename',
  async handle({ originUri, renameLocal }) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const origin = resourceFor(this.fileService, this.config, originUri);

    // Both sides of a rename on the server have to be the server's own paths.
    // The caller knows the file by one name or the other, and which one depends
    // on whether it was asked for in the file explorer or the remote one.
    await fileOperations.rename(
      origin.remoteFsPath,
      this.target.remoteFsPath,
      remoteFs
    );

    if (!renameLocal) {
      return;
    }

    const from = origin.localFsPath;
    const to = this.target.localFsPath;

    if (!(await fse.pathExists(from))) {
      // Nothing downloaded under the old name, so nothing here to follow.
      return;
    }

    if (await fse.pathExists(to)) {
      logger.warn(
        `renamed on the server, but ${to} is already here, so the local copy ` +
          `keeps the name it has`
      );
      return;
    }

    try {
      await fse.move(from, to);
    } catch (error) {
      // The server has already been renamed, so this cannot be swallowed: the
      // two sides now disagree, and only saying so lets anybody put it right.
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
