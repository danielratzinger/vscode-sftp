import { Readable } from 'stream';
import * as fileOperations from './fileBaseOperations';
import {
  DirectTransfer,
  FileStats,
  FileSystem,
  FileType,
  LocalFileSystem,
  isTransientError,
  supportsDirectTransfer,
} from './fs';
import { Task } from './scheduler';
import logger from '../logger';

let hasWarnedModifedTimePermission = false;

// A dropped connection says nothing about the file, so give it another go
// rather than leaving a hole in the transfer.
const MAX_TRANSFER_ATTEMPTS = 3;
const RETRY_DELAY = 200;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The bytes that arrived don't match the bytes we were told to send.
 */
export class TransferIntegrityError extends Error {
  readonly isIntegrityError = true;

  constructor(message: string) {
    super(message);
    // Restore the prototype chain, which breaks when targeting ES5.
    Object.setPrototypeOf(this, TransferIntegrityError.prototype);
  }
}

function isRetriable(error: any): boolean {
  if (!error || FileSystem.isAbortedError(error)) {
    return false;
  }

  return isTransientError(error) || error.isIntegrityError === true;
}

interface DirectRoute {
  fileSystem: FileSystem & DirectTransfer;
  isUpload: boolean;
}

export enum TransferDirection {
  LOCAL_TO_REMOTE = 'local ➞ remote',
  REMOTE_TO_LOCAL = 'remote ➞ local',
}

interface FileHandle {
  fsPath: string;
  fileSystem: FileSystem;
}

export interface TransferOption {
  atime: number;
  mtime: number;
  /** Size of the source file, used to check the transfer arrived whole. */
  size?: number;
  /** Defaults to on; set false to skip the post-transfer size check. */
  verify?: boolean;
  mode?: number;
  filePerm?: number;
  dirPerm?: number;
  fallbackMode?: number;
  perserveTargetMode: boolean;
  useTempFile?: boolean;
  openSsh?: boolean;
  /**
   * Called once before a download writes, with the local file it is about to
   * replace. Where the copy goes, and whether one is worth keeping at all, is
   * not this layer's business - it only knows the moment.
   */
  keepReplaced?(
    localPath: string,
    incoming: { size?: number; mtime: number }
  ): Promise<void>;
}

export default class TransferTask implements Task {
  readonly fileType: FileType;
  private readonly _srcFsPath: string;
  private readonly _targetFsPath: string;
  private readonly _srcFs: FileSystem;
  private readonly _targetFs: FileSystem;
  private readonly _transferDirection: TransferDirection;
  private readonly _TransferOption: TransferOption;
  private _handle: Readable;
  private _cancelled: boolean;
  // private _fileStatus: FileStatus;

  constructor(
    src: FileHandle,
    target: FileHandle,
    option: {
      fileType: FileType;
      transferDirection: TransferDirection;
      transferOption: TransferOption;
    }
  ) {
    this._srcFsPath = src.fsPath;
    this._targetFsPath = target.fsPath;
    this._srcFs = src.fileSystem;
    this._targetFs = target.fileSystem;
    this._TransferOption = option.transferOption;
    this._transferDirection = option.transferDirection;
    this.fileType = option.fileType;
  }

  get localFsPath() {
    if (this._transferDirection === TransferDirection.REMOTE_TO_LOCAL) {
      return this._targetFsPath;
    } else {
      return this._srcFsPath;
    }
  }

  get srcFsPath() {
    return this._srcFsPath;
  }

  get targetFsPath() {
    return this._targetFsPath;
  }

  get transferType() {
    return this._transferDirection;
  }

  async run() {
    const src = this._srcFsPath;
    const target = this._targetFsPath;
    const srcFs = this._srcFs;
    const targetFs = this._targetFs;
    switch (this.fileType) {
      case FileType.File:
        await this._transferFileWithRetry();
        break;
      case FileType.SymbolicLink:
        await fileOperations.transferSymlink(
          src,
          target,
          srcFs,
          targetFs,
          this._TransferOption
        );
        break;
      default:
        logger.warn(`Unsupported file type (type = ${this.fileType}). File ${src}`);
    }
  }

  cancel() {
    if (this._handle && !this._cancelled) {
      this._cancelled = true;
      FileSystem.abortReadableStream(this._handle);
    }
  }

  isCancelled(): boolean {
    return this._cancelled;
  }

  private async _transferFileWithRetry() {
    // Before the first attempt, not inside the loop: a retry is the same
    // transfer, and the file it would copy has already been half replaced.
    await this._keepWhatIsThere();

    for (let attempt = 1; ; attempt += 1) {
      try {
        await this._transferFile(attempt >= MAX_TRANSFER_ATTEMPTS);
        return;
      } catch (error) {
        // A half-read source stream can be holding a connection open, and the
        // next attempt opens its own.
        this._disposeHandle();

        if (
          attempt >= MAX_TRANSFER_ATTEMPTS ||
          this._cancelled ||
          !isRetriable(error)
        ) {
          throw error;
        }

        logger.warn(
          `${this._transferDirection} ${this._srcFsPath} failed ` +
            `(${error.message}), attempt ${attempt + 1} of ${MAX_TRANSFER_ATTEMPTS}`
        );
        await delay(this._retryDelay(attempt));
      }
    }
  }

  /**
   * Keeps whatever a download is about to write over.
   *
   * Downloads only: the same code uploads, and keeping the remote file would
   * mean fetching it first - a transfer for every transfer.
   */
  private async _keepWhatIsThere(): Promise<void> {
    const { keepReplaced, size, mtime } = this._TransferOption;

    if (
      !keepReplaced ||
      this._transferDirection !== TransferDirection.REMOTE_TO_LOCAL
    ) {
      return;
    }

    try {
      await keepReplaced(this._targetFsPath, { size, mtime });
    } catch (error) {
      // A copy that cannot be kept is not a reason to refuse the download the
      // user asked for; it is a safety net, not the floor.
      logger.warn(
        `could not keep a copy of ${this._targetFsPath}: ${error.message}`
      );
    }
  }

  /**
   * Backs off a little between attempts, to give a server that is briefly
   * refusing a chance to recover. Overridable so tests needn't wait it out.
   */
  protected _retryDelay(attempt: number): number {
    return RETRY_DELAY * attempt;
  }

  private async _transferFile(isLastAttempt: boolean) {
    const uploadTarget =
      this._targetFsPath + (this._TransferOption.useTempFile ? '.new' : '');

    const route = this._directRoute();
    if (route) {
      await this._writeDirectly(route, uploadTarget);
    } else {
      await this._writeByStream(uploadTarget);
    }

    // Before the temp file is promoted, so a short transfer can't replace a
    // good file with a broken one.
    await this._verifyWritten(uploadTarget, isLastAttempt);
    await this._promoteTempFile(uploadTarget);
  }

  /**
   * Whether one side is local and the other can move the file by itself. Those
   * implementations pipeline, while the generic stream route below is stuck
   * with a single request in flight.
   */
  private _directRoute(): DirectRoute | null {
    if (
      this._srcFs instanceof LocalFileSystem &&
      supportsDirectTransfer(this._targetFs)
    ) {
      return { fileSystem: this._targetFs, isUpload: true };
    }

    if (
      this._targetFs instanceof LocalFileSystem &&
      supportsDirectTransfer(this._srcFs)
    ) {
      return { fileSystem: this._srcFs, isUpload: false };
    }

    return null;
  }

  private async _writeDirectly(route: DirectRoute, uploadTarget: string) {
    const { atime, mtime, useTempFile } = this._TransferOption;
    const mode = await this._resolveMode();

    if (useTempFile) {
      logger.info('uploading temp file: ' + uploadTarget);
    }

    if (route.isUpload) {
      await route.fileSystem.uploadFromLocal(this._srcFsPath, uploadTarget, {
        mode,
      });
    } else {
      await route.fileSystem.downloadToLocal(this._srcFsPath, uploadTarget, {
        mode,
      });
    }

    if (atime && mtime) {
      try {
        await this._targetFs.utimes(
          uploadTarget,
          Math.floor(atime / 1000),
          Math.floor(mtime / 1000)
        );
      } catch (error) {
        this._warnAboutModifiedTime(error);
      }
    }
  }

  /**
   * The mode the written file should end up with, matching what the stream
   * route below arrives at.
   */
  private async _resolveMode(): Promise<number | undefined> {
    const {
      perserveTargetMode,
      fallbackMode,
      filePerm,
      useTempFile,
    } = this._TransferOption;

    const configured = filePerm
      ? parseInt(String(filePerm), 8)
      : this._TransferOption.mode;
    if (configured !== undefined || !perserveTargetMode) {
      return configured;
    }

    // Writing straight to the target keeps the mode it already has, since
    // opening a file for writing doesn't touch its permissions, and a file
    // that isn't there yet is the server's to set up.
    if (!useTempFile) {
      return undefined;
    }

    // A temp file is a new file, so the mode has to be carried over the rename.
    try {
      const stat = await this._targetFs.lstat(this._targetFsPath);
      return stat.mode;
    } catch (error) {
      return fallbackMode;
    }
  }

  private async _verifyWritten(uploadTarget: string, isLastAttempt: boolean) {
    const expected = this._TransferOption.size;
    if (this._TransferOption.verify === false || expected === undefined) {
      return;
    }

    let actual: number | undefined;
    try {
      actual = await this._targetFs.size(uploadTarget);
    } catch (error) {
      // Not being able to check is not the same as being wrong.
      logger.debug(
        `can't check the size of ${uploadTarget}: ${error.message}`
      );
      return;
    }

    if (actual === undefined || actual === expected) {
      return;
    }

    return this._explainMismatch(actual, expected, isLastAttempt);
  }

  /**
   * The size to expect was read when the transfer was planned - for a folder,
   * one listing covering every file in it - so by the time a given file is
   * read the source may have moved on. That is a stale expectation, not a
   * broken transfer, and the difference is worth a single stat to establish.
   */
  private async _explainMismatch(
    actual: number,
    expected: number,
    isLastAttempt: boolean
  ): Promise<void> {
    const source = await this._sourceStatNow();
    const current = source && source.size;

    if (current !== undefined && current !== expected) {
      // Whatever happens next, a retry that compares against the old number
      // can only fail the same way again.
      this._refreshSourceExpectation(source!);

      if (actual === current) {
        // The source was rewritten around the read, and what landed is the
        // size it now holds. Read it again while there are attempts left,
        // since a file that grew mid-read can arrive stitched together, and
        // settle for this copy rather than fail when there are not.
        if (isLastAttempt) {
          logger.warn(
            `${this._srcFsPath} kept changing while it was read ` +
              `(${expected} ➞ ${current} bytes); keeping the copy that ` +
              `matches it as it now stands`
          );
          return;
        }

        throw new TransferIntegrityError(
          `${this._srcFsPath} changed while it was read ` +
            `(${expected} ➞ ${current} bytes), reading it again`
        );
      }
    }

    const reference = current === undefined ? expected : current;
    if (actual < reference) {
      throw new TransferIntegrityError(
        `${this._targetFsPath} arrived incomplete: ` +
          `expected ${reference} bytes, got ${actual}`
      );
    }

    throw new TransferIntegrityError(
      `${this._targetFsPath} arrived longer than its source: ` +
        `expected ${reference} bytes, got ${actual}`
    );
  }

  /**
   * What the source holds now, or undefined when it won't say - a check that
   * cannot be made says nothing either way.
   */
  private async _sourceStatNow(): Promise<FileStats | undefined> {
    try {
      return await this._srcFs.lstat(this._srcFsPath);
    } catch (error) {
      logger.debug(
        `can't re-read ${this._srcFsPath}: ${error.message}`
      );
      return undefined;
    }
  }

  /**
   * Carries a moved-on source into the next attempt, timestamps included, so
   * the copy it writes is stamped with the file it actually read.
   */
  private _refreshSourceExpectation(stat: FileStats) {
    this._TransferOption.size = stat.size;
    if (stat.mtime) {
      this._TransferOption.mtime = stat.mtime;
    }
    if (stat.atime) {
      this._TransferOption.atime = stat.atime;
    }
  }

  private async _promoteTempFile(uploadTarget: string) {
    const { useTempFile, openSsh } = this._TransferOption;
    if (!useTempFile) {
      return;
    }

    const target = this._targetFsPath;
    const targetFs = this._targetFs;

    logger.info('moving from: ' + uploadTarget + ' to: ' + target);
    if (openSsh) {
      await targetFs.renameAtomic(uploadTarget, target);
    } else {
      try {
        await targetFs.unlink(target);
      } catch (error) {
        // Just ignore
      }
      await targetFs.rename(uploadTarget, target);
    }
  }

  private _disposeHandle() {
    const handle = this._handle as any;
    this._handle = undefined as any;

    if (handle && typeof handle.destroy === 'function' && !handle.destroyed) {
      handle.destroy();
    }
  }

  private _warnAboutModifiedTime(error: Error) {
    if (hasWarnedModifedTimePermission) {
      return;
    }

    hasWarnedModifedTimePermission = true;
    logger.warn(`Can't set modified time to the file because ${error.message}`);
  }

  private async _writeByStream(uploadTarget: string) {
    const src = this._srcFsPath;
    const target = this._targetFsPath;
    const srcFs = this._srcFs;
    const targetFs = this._targetFs;
    const {
      perserveTargetMode,
      useTempFile,
      fallbackMode,
      atime,
      mtime,
      filePerm
    } = this._TransferOption;
    // Set the mode if it's specified in the config, otherwise get mode from server.
    let mode = filePerm ? parseInt(String(filePerm), 8) : this._TransferOption.mode;
    let targetFd; // Destination file
    let uploadFd; // Temp file or destination file when no temp file is used

    // Use mode first.
    // Then check perserveTargetMode and fallback to fallbackMode if fail to get mode of target
    if (mode === undefined && perserveTargetMode) {
      if (useTempFile) {
        [targetFd, uploadFd] = await Promise.all([
          targetFs.open(target, 'r')  // Get handle for reading the target mode
            .catch(() => null), // Return null if target file doesn't exist
          targetFs.open(uploadTarget, 'w')  // Get handle for the file upload
        ]);
      } else {
        targetFd = uploadFd = await targetFs.open(uploadTarget, 'w');
      }

      if (targetFd) {
        [this._handle, mode] = await Promise.all([
          srcFs.get(src),
          targetFs
            .fstat(targetFd)
            .then(stat => stat.mode)
            .catch(() => fallbackMode),
        ]);

        if (useTempFile) {
          targetFs.close(targetFd);
        }

      } else {
        this._handle = await srcFs.get(src);
        mode = fallbackMode;
      }

    } else {
      [this._handle, uploadFd] = await Promise.all([
        srcFs.get(src),
        targetFs.open(uploadTarget, 'w'),
      ]);
    }

    try {
      if (useTempFile) {
        logger.info("uploading temp file: " + uploadTarget);
      }
      await targetFs.put(this._handle, uploadTarget, {
        mode,
        fd: uploadFd,
        autoClose: false,
      });
      if (atime && mtime) {
        try {
          await targetFs.futimes(
            uploadFd,
            Math.floor(atime / 1000),
            Math.floor(mtime / 1000)
          );
        } catch (error) {
          this._warnAboutModifiedTime(error);
        }
      }
    } finally {
      await targetFs.close(uploadFd);
    }
  }
}
