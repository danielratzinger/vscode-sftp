import { Readable } from 'stream';
import * as fs from 'fs';

interface FileSystemError extends Error {
  code: string;
}

export const ERROR_MSG_STREAM_INTERRUPT = 'sftp.stream.interrupt';

export type FileHandle = unknown;

export enum FileType {
  Directory = 1,
  File,
  SymbolicLink,
  Unknown,
}

export interface FileOption {
  flags?: string;
  encoding?: string;
  mode?: number;
  autoClose?: boolean;
  fd?: FileHandle;
}

export interface FileStats {
  type: FileType;
  mode: number;
  size: number;
  mtime: number;
  atime: number;
  // symbol link target
  target?: string;
}

export type FileEntry = FileStats & {
  fspath: string;
  name: string;
};

export interface DirectTransferOption {
  mode?: number;
}

/**
 * A remote file system that can move a file to or from a local path on its
 * own, instead of going through the generic `get()` -> pipe -> `put()` route.
 *
 * Worth implementing when the protocol can keep several requests in flight:
 * the generic route is limited to whatever a single stream manages, which on
 * SFTP means one chunk per round trip.
 */
export interface DirectTransfer {
  downloadToLocal(
    remotePath: string,
    localPath: string,
    option?: DirectTransferOption
  ): Promise<void>;
  uploadFromLocal(
    localPath: string,
    remotePath: string,
    option?: DirectTransferOption
  ): Promise<void>;
}

export function supportsDirectTransfer(
  fileSystem: FileSystem
): fileSystem is FileSystem & DirectTransfer {
  return (
    typeof (fileSystem as any).downloadToLocal === 'function' &&
    typeof (fileSystem as any).uploadFromLocal === 'function'
  );
}

export default abstract class FileSystem {
  static getFileTypecharacter(stat: fs.Stats): FileType {
    if (stat.isDirectory()) {
      return FileType.Directory;
    } else if (stat.isFile()) {
      return FileType.File;
    } else if (stat.isSymbolicLink()) {
      return FileType.SymbolicLink;
    } else {
      return FileType.Unknown;
    }
  }

  pathResolver: any;

  constructor(pathResolver: any) {
    this.pathResolver = pathResolver;
  }

  abstract readFile(path: string, option?: FileOption): Promise<string | Buffer>;
  abstract open(path: string, flags: string, mode?: number): Promise<FileHandle>;
  abstract close(fd: FileHandle): Promise<void>;
  abstract fstat(fd: FileHandle): Promise<FileStats>;
  /**
   * Change the file system timestamps of the object referenced by the supplied file descriptor.
   *
   * @abstract
   * @param {FileHandle} fd
   * @param {number} atime time in seconds
   * @param {number} mtime time in seconds
   * @returns {Promise<void>}
   * @memberof FileSystem
   */
  abstract futimes(fd: FileHandle, atime: number, mtime: number): Promise<void>;
  abstract get(path: string, option?: FileOption): Promise<Readable>;
  abstract put(input: Readable, path, option?: FileOption): Promise<void>;
  abstract mkdir(dir: string): Promise<void>;
  abstract ensureDir(dir: string): Promise<void>;
  abstract chmod(path: string, mode: number): Promise<void>;
  abstract list(dir: string, option?): Promise<FileEntry[]>;
  abstract lstat(path: string): Promise<FileStats>;
  /**
   * Set the access and modification times of a file by path, in seconds.
   */
  abstract utimes(path: string, atime: number, mtime: number): Promise<void>;
  abstract readlink(path: string): Promise<string>;
  abstract symlink(targetPath: string, path: string): Promise<void>;
  abstract unlink(path: string): Promise<void>;
  abstract rmdir(path: string, recursive: boolean): Promise<void>;
  abstract rename(srcPath: string, destPath: string): Promise<void>;
  abstract renameAtomic(srcPath: string, destPath: string): Promise<void>;

  /**
   * Size of a file in bytes, or `undefined` when the file system can't say.
   * Used to check that a transfer arrived whole, so an implementation should
   * answer as cheaply as it can and never guess.
   */
  async size(path: string): Promise<number | undefined> {
    const stat = await this.lstat(path);
    return stat.size;
  }

  static abortReadableStream(stream: Readable) {
    const err = new Error('Transfer Aborted') as FileSystemError;
    err.code = ERROR_MSG_STREAM_INTERRUPT;

    // don't do `stream.destroy(err)`! `sftp.ReadaStream` do not support `err` parameter in `destory` method.
    stream.emit('error', err);
    stream.destroy();
  }

  static isAbortedError(err: FileSystemError) {
    return err.code === ERROR_MSG_STREAM_INTERRUPT;
  }
}
