import { FileType, FileSystem } from '../fs';
import TransferTask, {
  TransferDirection,
  TransferOption,
} from '../transferTask';
import { ExecChannel } from '../remote-client/sshClient';
import { extractInto } from './extract';
import {
  ExecHost,
  TarFlavour,
  ask,
  folderSizeCommand,
  packFolderCommand,
  readFolderSize,
} from './serverTar';
import { occasionally } from './progress';
import { roomFor } from './space';
import { describeSize } from '../../helper';
import logger from '../../logger';

interface ArchiveHandle {
  fsPath: string;
  fileSystem: FileSystem;
}

/**
 * The part of a transfer's options an archive has any use for. The rest is
 * about one file at a time, which is what this is instead of.
 */
export type ArchiveTransferOption = Partial<TransferOption>;

/**
 * A folder fetched as one archive instead of one file at a time.
 *
 * It is a transfer task like any other so that everything watching transfers -
 * the status bar, the log, the error reporting - sees what it always sees: one
 * thing moving from one side to the other. What is different is only how the
 * bytes get here.
 *
 * Whatever goes wrong, the folder still has to arrive. Anything short of a
 * cancellation hands over to the file-by-file walk, which needs nothing but
 * SFTP and has already been asked to overwrite whatever the archive managed to
 * write before it failed.
 */
export default class ArchiveDownloadTask extends TransferTask {
  private readonly _remoteDir: string;
  private readonly _localDir: string;
  private readonly _host: ExecHost;
  private readonly _flavour: TarFlavour;
  private readonly _option: ArchiveTransferOption;
  private readonly _fallBackToFileByFile: () => Promise<void>;
  private _channel: ExecChannel | null = null;

  constructor(
    src: ArchiveHandle,
    target: ArchiveHandle,
    option: {
      transferOption: ArchiveTransferOption;
      flavour: TarFlavour;
      fallBackToFileByFile(): Promise<void>;
    }
  ) {
    super(src, target, {
      fileType: FileType.Directory,
      transferDirection: TransferDirection.REMOTE_TO_LOCAL,
      // The timestamps and the size belong to the one-file-at-a-time transfer
      // the base class does, and `run` below replaces all of it. A folder has
      // no size of its own to check, and nothing here reads them.
      transferOption: {
        ...option.transferOption,
        atime: 0,
        mtime: 0,
        perserveTargetMode: false,
      },
    });

    this._remoteDir = src.fsPath;
    this._localDir = target.fsPath;
    this._host = (src.fileSystem as any) as ExecHost;
    this._flavour = option.flavour;
    this._option = option.transferOption;
    this._fallBackToFileByFile = option.fallBackToFileByFile;
  }

  cancel() {
    super.cancel();

    if (this._channel) {
      this._channel.cancel();
    }
  }

  async run() {
    const coming = await this._howMuchIsComing();
    const room = await roomFor(coming, this._localDir);

    if (!room.fits) {
      // Refused here rather than found out in the middle of it. Going file by
      // file would fill the disk just as surely, so this is not a reason to fall
      // back - it is a reason to stop.
      const full: any = new Error(
        `${this._remoteDir} will not fit: ${room.because}`
      );
      full.noPointRetrying = true;
      throw full;
    }

    const command = packFolderCommand(this._flavour, this._remoteDir);

    let channel: ExecChannel;
    try {
      channel = await this._host.exec(command);
    } catch (error) {
      return this._giveUp(`tar would not start: ${error.message}`);
    }

    this._channel = channel;
    logger.info(`[archive] reading ${this._remoteDir} as one archive`);

    // There is no total to count towards: nobody listed the folder, which is
    // the saving. So it says what has arrived, which is enough to tell a slow
    // transfer from a stopped one.
    const sayWhereItIs = occasionally();

    try {
      const result = await extractInto(channel.stdout, {
        localBase: this._localDir,
        ignore: this._option.ignore,
        fileFilter: this._option.fileFilter,
        keepReplaced: this._option.keepReplaced,
        stallAfter: this._host.operationTimeout,
        verify: this._option.verify,
        onProgress: sofar =>
          sayWhereItIs(
            () =>
              `[archive] ${this._remoteDir}: ${sofar.files} file${
                sofar.files === 1 ? '' : 's'
              }, ${describeSize(sofar.bytes)}` +
              (coming === undefined ? ' so far' : ` of about ${describeSize(coming)}`)
          ),
      });

      const code = await channel.done;
      if (code !== 0) {
        throw new Error(
          `tar exited ${code}${channel.stderr() ? `: ${channel.stderr()}` : ''}`
        );
      }

      logger.info(
        `[archive] ${this._remoteDir}: ${result.files} file${
          result.files === 1 ? '' : 's'
        }, ${describeSize(result.bytes)}` +
          (result.skipped ? `, ${result.skipped} skipped` : '') +
          (result.refused ? `, ${result.refused} this machine would not write` : '')
      );
    } catch (error) {
      // Whatever went wrong, the server is still packing and will sit there
      // blocked on a window nobody is emptying. Ending the channel ends its
      // tar too, and frees the connection for the transfer that follows.
      channel.cancel();

      // Asked to stop is not gone wrong, and starting the long way round after
      // being told to stop would be the opposite of what was asked. Neither is
      // a full disk: file by file would fill it the same way, one dialog at a
      // time.
      if (this.isCancelled() || error.noPointRetrying) {
        throw error;
      }

      return this._giveUp(error.message);
    } finally {
      this._channel = null;
    }
  }

  /**
   * What the folder comes to on the server, as far as it will say.
   *
   * One round trip and a walk the server was about to do anyway. Unknown is a
   * perfectly good answer - the transfer then goes ahead as it did before, and
   * a disk that fills up is caught as it happens instead of beforehand.
   */
  private async _howMuchIsComing(): Promise<number | undefined> {
    const answer = await ask(this._host, folderSizeCommand(this._remoteDir));
    if (!answer || answer.code !== 0) {
      return undefined;
    }

    return readFolderSize(answer.output);
  }

  private async _giveUp(why: string): Promise<void> {
    logger.warn(
      `[archive] ${this._remoteDir} is going file by file instead: ${why}`
    );
    await this._fallBackToFileByFile();
  }
}
