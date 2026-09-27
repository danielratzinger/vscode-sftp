import createFileHandler from './createFileHandler';
import logger from '../logger';

/**
 * Changing what a file on the server may be done with.
 *
 * Only the file or folder it is asked about, never what is inside one: files and
 * folders want different modes, so a single mode applied all the way down is
 * almost always wrong - `755` over a folder of PHP makes every one of them
 * executable.
 */
export const chmodRemote = createFileHandler<{ mode: number }>({
  name: 'chmod',
  async handle({ mode }) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const { remoteFsPath } = this.target;

    await remoteFs.chmod(remoteFsPath, mode);
    logger.info(`${remoteFsPath} is now ${(mode & 0o7777).toString(8)}`); // tslint:disable-line:no-bitwise
  },
});
