import * as tar from 'tar';
import { Transform } from 'stream';
import { FileSystem, FileType } from '../fs';
import TransferTask, {
  TransferDirection,
  TransferOption,
} from '../transferTask';
import { ExecChannel } from '../remote-client/sshClient';
import { LocalTree } from './localTree';
import { ExecHost, TarFlavour } from './serverTar';
import { promoteScript, unpackCommand } from './remoteScript';
import { occasionally } from './progress';
import { describeSize } from '../../helper';
import logger from '../../logger';

interface ArchiveHandle {
  fsPath: string;
  fileSystem: FileSystem;
}

/** Enough of a name to tell two uploads to the same folder apart. */
function stagingId(): string {
  return Math.random()
    .toString(16)
    .slice(2, 10);
}

/**
 * A folder sent as one archive instead of one file at a time.
 *
 * Two commands, not one. The first unpacks into a staging folder inside the
 * target; the second moves each file into place, which within one file system
 * is a rename - so a file is the old one or the new one and never half of
 * either. A plain `tar -x` straight into the target could not say that, and for
 * a folder being served to the internet the difference is between slow and
 * briefly broken.
 *
 * Whatever goes wrong short of a cancellation, the folder still has to arrive,
 * so it hands over to the file-by-file walk - which rewrites whatever did land
 * and is none the worse for it.
 */
export default class ArchiveUploadTask extends TransferTask {
  private readonly _localDir: string;
  private readonly _remoteDir: string;
  private readonly _host: ExecHost;
  private readonly _flavour: TarFlavour;
  private readonly _tree: LocalTree;
  private readonly _option: Partial<TransferOption>;
  private readonly _fallBackToFileByFile: () => Promise<void>;
  private _channel: ExecChannel | null = null;

  constructor(
    src: ArchiveHandle,
    target: ArchiveHandle,
    option: {
      transferOption: Partial<TransferOption>;
      flavour: TarFlavour;
      tree: LocalTree;
      fallBackToFileByFile(): Promise<void>;
    }
  ) {
    super(src, target, {
      fileType: FileType.Directory,
      transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      transferOption: {
        ...option.transferOption,
        atime: 0,
        mtime: 0,
        perserveTargetMode: false,
      },
    });

    this._localDir = src.fsPath;
    this._remoteDir = target.fsPath;
    this._host = (target.fileSystem as any) as ExecHost;
    this._flavour = option.flavour;
    this._tree = option.tree;
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
    const id = stagingId();

    try {
      await this._unpack(id);
      await this._promote(id);
    } catch (error) {
      // Whichever command it was, it is still on the other end. Ending the
      // channel ends it, and the staging folder goes with it: the trap catches
      // the hangup.
      if (this._channel) {
        this._channel.cancel();
        this._channel = null;
      }

      if (this.isCancelled() || error.noPointRetrying) {
        throw error;
      }

      logger.warn(
        `[archive] ${this._localDir} is going file by file instead: ${error.message}`
      );
      await this._fallBackToFileByFile();
      return;
    }

    logger.info(
      `[archive] ${this._remoteDir}: ${this._tree.files.length} file${
        this._tree.files.length === 1 ? '' : 's'
      } in one archive`
    );
  }

  /**
   * Sends the archive as it is made, so nothing of it is ever on disk at either
   * end. Only the files the walk chose are named, and folders are left to the
   * script below - which is also what gives an empty folder somewhere to be.
   */
  private async _unpack(id: string): Promise<void> {
    const channel = await this._host.exec(unpackCommand(this._remoteDir, id));
    this._channel = channel;

    // How many files it has reached, which is progress through the list rather
    // than a guess: tar takes them in the order they are given.
    const total = this._tree.files.length;
    const remoteDir = this._remoteDir;
    let reached = 0;
    let sent = 0;
    const sayWhereItIs = occasionally();

    const archive = tar.create(
      {
        gzip: { level: 1 },
        cwd: this._localDir,
        // A link stays a link, and the timestamps come with it.
        follow: false,
        portable: false,
        noDirRecurse: true,
        filter: () => {
          reached += 1;
          return true;
        },
      } as any,
      this._tree.files.map(file => file.path)
    );

    // Counted in a transform rather than by listening for data: the archive is
    // a minipass stream, where adding a data handler starts it flowing there and
    // then, and anything it had already buffered would go out before the pipe
    // below was attached to catch it - which is a hole in the middle of a file.
    const counted = new Transform({
      transform(chunk, _encoding, done) {
        sent += chunk.length;
        sayWhereItIs(
          () =>
            `[archive] ${remoteDir}: ${Math.min(reached, total)} of ` +
            `${total} files packed, ${describeSize(sent)} sent`
        );
        done(undefined, chunk);
      },
    });

    await new Promise<void>((resolve, reject) => {
      archive.on('error', reject);
      counted.on('error', reject);
      channel.stdin.on('error', reject);
      channel.stdin.on('finish', () => resolve());
      (archive as any).pipe(counted).pipe(channel.stdin);
    });

    const code = await channel.done;
    this._channel = null;

    if (code !== 0) {
      throw new Error(
        `tar exited ${code}${channel.stderr() ? `: ${channel.stderr()}` : ''}`
      );
    }
  }

  /**
   * Feeds the move script to a shell on standard input rather than as a command
   * line, because a folder of ten thousand files is a script of ten thousand
   * lines and no argument list is that long.
   */
  private async _promote(id: string): Promise<void> {
    const script = promoteScript({
      target: this._remoteDir,
      id,
      flavour: this._flavour,
      directories: this._tree.directories,
      files: this._tree.files,
      filePerm: this._option.filePerm,
      dirPerm: this._option.dirPerm,
    });

    const channel = await this._host.exec('sh -s');
    this._channel = channel;
    channel.stdin.end(script);

    const code = await channel.done;
    this._channel = null;

    if (code !== 0) {
      throw new Error(
        `${code} file${code === 1 ? '' : 's'} could not be put in place` +
          (channel.stderr() ? `: ${channel.stderr()}` : '')
      );
    }
  }
}
