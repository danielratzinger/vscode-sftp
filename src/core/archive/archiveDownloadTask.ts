import { FileType, FileSystem } from '../fs';
import TransferTask, {
  TransferDirection,
  TransferOption,
} from '../transferTask';
import { ExecChannel } from '../remote-client/sshClient';
import { extractInto } from './extract';
import { ExecHost, TarFlavour, packFolderCommand } from './serverTar';
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
    const command = packFolderCommand(this._flavour, this._remoteDir);

    let channel: ExecChannel;
    try {
      channel = await this._host.exec(command);
    } catch (error) {
      return this._giveUp(`tar would not start: ${error.message}`);
    }

    this._channel = channel;
    logger.info(`[archive] reading ${this._remoteDir} as one archive`);

    try {
      const result = await extractInto(channel.stdout, {
        localBase: this._localDir,
        ignore: this._option.ignore,
        keepReplaced: this._option.keepReplaced,
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
        }, ${result.bytes} bytes` +
          (result.skipped ? `, ${result.skipped} skipped` : '')
      );
    } catch (error) {
      // Asked to stop is not gone wrong, and starting the long way round after
      // being told to stop would be the opposite of what was asked.
      if (this.isCancelled()) {
        throw error;
      }

      return this._giveUp(error.message);
    } finally {
      this._channel = null;
    }
  }

  private async _giveUp(why: string): Promise<void> {
    logger.warn(
      `[archive] ${this._remoteDir} is going file by file instead: ${why}`
    );
    await this._fallBackToFileByFile();
  }
}
