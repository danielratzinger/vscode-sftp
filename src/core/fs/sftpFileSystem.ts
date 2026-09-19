import { Readable, Writable } from 'stream';
import FileSystem, {
  FileEntry,
  FileType,
  FileStats,
  FileOption,
  DirectTransfer,
  DirectTransferOption,
} from './fileSystem';
import RemoteFileSystem from './remoteFileSystem';
import {
  OperationTimeoutError,
  watchForStall,
} from './operationTimeout';
import SSHClient from '../remote-client/sshClient';

type FileHandle = Buffer;

interface SFTPFileDescriptor {
  handle: FileHandle;
  path: string;
}

interface WriteStream extends Writable {
  handle: Buffer;
  path: string;
  flags: string;
  mode: number;
  destroy(): void;
  close(): void;
}

function toSimpleFileMode(mode: number) {
  return mode & parseInt('777', 8); // tslint:disable-line:no-bitwise
}

/**
 * ssh2's SFTP streams keep exactly one request in flight, which caps a
 * transfer at one chunk per round trip no matter how much bandwidth is going
 * spare. `fastGet`/`fastPut` pipeline instead; these are their defaults,
 * repeated here so the numbers are visible where they matter.
 */
const TRANSFER_CONCURRENCY = 64;
const TRANSFER_CHUNK_SIZE = 32768;

/** Transfers are watched for silence, not given a deadline. */
const TRANSFERS = [
  'fastGet',
  'fastPut',
  'createReadStream',
  'createWriteStream',
];

export default class SFTPFileSystem extends RemoteFileSystem
  implements DirectTransfer {
  private _guarded: { raw: any; guarded: any } | null = null;

  /**
   * The ssh2 client, with every command given a deadline.
   *
   * SSH keepalives notice a peer that has gone away, but not one that is still
   * answering and has stopped replying to this particular request - a server
   * whose own storage has hung, most often. The callback would simply never
   * come, and each of the methods below is a promise waiting for it.
   *
   * Wrapping the client rather than the seventeen methods means a call added
   * later is covered without anyone remembering to cover it.
   */
  get sftp() {
    const raw = this.getClient().getFsClient();

    if (!this._guarded || this._guarded.raw !== raw) {
      this._guarded = { raw, guarded: this._guard(raw) };
    }

    return this._guarded.guarded;
  }

  setOperationTimeout(ms: number): void {
    this._operationTimeout = ms;
    // The guard closes over the timeout, so it has to be built again.
    this._guarded = null;
  }

  private _guard(raw: any): any {
    const ms = this._operationTimeout;
    if (!raw || !(ms > 0)) {
      return raw;
    }

    return new Proxy(raw, {
      get: (target: any, property: PropertyKey) => {
        const value = target[property];

        if (
          typeof value !== 'function' ||
          TRANSFERS.indexOf(String(property)) !== -1
        ) {
          return typeof value === 'function' ? value.bind(target) : value;
        }

        return (...args: any[]) => {
          const callback = args[args.length - 1];
          if (typeof callback !== 'function') {
            return value.apply(target, args);
          }

          let answered = false;
          const timer = setTimeout(() => {
            if (answered) {
              return;
            }
            answered = true;
            // The request is abandoned, not cancelled: SFTP has no way to
            // recall one. A late reply arrives to a callback that ignores it.
            callback(
              new OperationTimeoutError(
                `${String(property)} ${args[0]}`,
                ms,
                false
              )
            );
          }, ms);

          if (typeof (timer as any).unref === 'function') {
            (timer as any).unref();
          }

          const guarded = (...result: any[]) => {
            if (answered) {
              return;
            }
            answered = true;
            clearTimeout(timer);
            callback(...result);
          };

          return value.apply(target, args.slice(0, -1).concat([guarded]));
        };
      },
    });
  }

  /**
   * Stops a transfer that has gone quiet.
   *
   * Rejecting on its own would leave ssh2 still writing to the file the caller
   * is about to retry, which is the one way this could damage a download.
   * Ending the connection is decisive: in-flight transfers fail, the retry
   * layer reconnects and repeats them, and nothing is left writing behind our
   * back.
   */
  private _watchTransfer(
    operation: string,
    onStall: (error: OperationTimeoutError) => void
  ) {
    return watchForStall(this._operationTimeout, operation, error => {
      try {
        this.getClient().end();
      } catch (endError) {
        // Already gone.
      }

      onStall(error);
    });
  }

  /**
   * Pipelined download straight to a local path, bypassing the single-request
   * read stream. Writes the whole file or fails; it never reports success on a
   * short read.
   */
  downloadToLocal(
    remotePath: string,
    localPath: string,
    option: DirectTransferOption = {}
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const watchdog = this._watchTransfer(
        `download ${remotePath}`,
        reject
      );

      this.sftp.fastGet(
        remotePath,
        localPath,
        {
          concurrency: TRANSFER_CONCURRENCY,
          chunkSize: TRANSFER_CHUNK_SIZE,
          mode: option.mode,
          step: () => watchdog.progress(),
        },
        err => {
          watchdog.stop();
          if (err) {
            reject(err);
            return;
          }

          resolve();
        }
      );
    });
  }

  /**
   * Pipelined upload from a local path. See `downloadToLocal`.
   */
  uploadFromLocal(
    localPath: string,
    remotePath: string,
    option: DirectTransferOption = {}
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const watchdog = this._watchTransfer(`upload ${remotePath}`, reject);

      this.sftp.fastPut(
        localPath,
        remotePath,
        {
          concurrency: TRANSFER_CONCURRENCY,
          chunkSize: TRANSFER_CHUNK_SIZE,
          mode: option.mode,
          step: () => watchdog.progress(),
        },
        err => {
          watchdog.stop();
          if (err) {
            reject(err);
            return;
          }

          resolve();
        }
      );
    });
  }

  /**
   * `lstat` would report the link itself; a transfer target is the file the
   * link points at, which is what got written.
   */
  async size(path: string): Promise<number | undefined> {
    return new Promise<number | undefined>(resolve => {
      this.sftp.stat(path, (err, stat) => {
        resolve(err ? undefined : stat.size);
      });
    });
  }

  toFileStat(stat): FileStats {
    return {
      type: FileSystem.getFileTypecharacter(stat),
      mode: toSimpleFileMode(stat.mode), // tslint:disable-line:no-bitwise
      size: stat.size,
      mtime: this.toLocalTime(stat.mtime * 1000),
      atime: this.toLocalTime(stat.atime * 1000),
    };
  }

  toFileEntry(fullPath, item): FileEntry {
    return {
      fspath: fullPath,
      name: item.filename,
      ...this.toFileStat(item.attrs),
    };
  }

  _createClient(option) {
    return new SSHClient(option);
  }

  lstat(path: string): Promise<FileStats> {
    return new Promise((resolve, reject) => {
      this.sftp.lstat(path, (err, stat) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(this.toFileStat(stat));
      });
    });
  }

  open(
    path: string,
    flags: string,
    mode?: number
  ): Promise<SFTPFileDescriptor> {
    return new Promise((resolve, reject) => {
      this.sftp.open(path, flags, mode, (err, handle) => {
        if (err) {
          return reject(err);
        }

        resolve({
          path,
          handle,
        });
      });
    });
  }

  close(fd: SFTPFileDescriptor): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.close(fd.handle, err => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  fstat(fd: SFTPFileDescriptor): Promise<FileStats> {
    return new Promise((resolve, reject) => {
      this.sftp.fstat(fd.handle, (err, stat) => {
        if (err) {
          // Try stat() for sftp servers that may not support fstat() for
          // whatever reason
          // see WriteStream.prototype.open in ssh2-streams.
          this.sftp.stat(fd.path, (_err, _stat) => {
            if (_err) {
              reject(err);
              return;
            }

            resolve(this.toFileStat(_stat));
          });
          return;
        }

        resolve(this.toFileStat(stat));
      });
    });
  }

  futimes(fd: SFTPFileDescriptor, atime: number, mtime: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.futimes(
        fd.handle,
        this.toRemoteTimeInSecnonds(atime),
        this.toRemoteTimeInSecnonds(mtime),
        err => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        }
      );
    });
  }

  utimes(path: string, atime: number, mtime: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.utimes(
        path,
        this.toRemoteTimeInSecnonds(atime),
        this.toRemoteTimeInSecnonds(mtime),
        err => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        }
      );
    });
  }

  fchmod(fd: SFTPFileDescriptor, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.fchmod(fd.handle, mode, err => {
        if (err) {
          // Try chmod() for sftp servers that may not support fchmod() for
          // whatever reason
          // see WriteStream.prototype.open in ssh2-streams.
          this.sftp.chmod(fd.path, mode, _err => {
            if (_err) {
              reject(err);
              return;
            }

            resolve();
          });
          return;
        }

        resolve();
      });
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.chmod(path, mode, err => {
        if(err) {
          reject(err)
          return
        }
        resolve();
      });
    })
  }

  get(path, option?: FileOption): Promise<Readable> {
    return new Promise((resolve, reject) => {
      // const opt = { ...option, autoDestroy: false };
      try {
        // const stream = this.sftp.createReadStream(path, opt);
        const stream = this.sftp.createReadStream(path, option);
        resolve(stream);
      } catch (err) {
        reject(err);
      }
    });
  }

  rename(srcPath: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.rename(srcPath, destPath, err => {
        if (err) {
          return reject(err);
        }

        resolve();
      });
    });
  }

  // See: https://github.com/mscdex/ssh2/issues/1054
  renameAtomic(srcPath: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.ext_openssh_rename(srcPath, destPath, err => {
        if (err) {
          return reject(err);
        }

        resolve();
      });
    });
  }

  async put(input: Readable, path, option?: FileOption): Promise<void> {
    if (option && option.fd) {
      const fd = option.fd as SFTPFileDescriptor;
      // const opt = { ...option, handle: fd.handle, autoDestroy: false };
      const opt = { ...option, handle: fd.handle };
      delete opt.fd;

      if (opt.mode) {
        // mode will get ignored if handle passed in.
        // call chmod manunally.
        try {
          await this.fchmod(fd, opt.mode);
        } catch {
          // ignore error
        }
      }

      return this._put(input, path, opt);
    }

    return this._put(input, path, option);
  }

  readlink(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.sftp.readlink(path, (err, linkString) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(linkString);
      });
    });
  }

  symlink(targetPath: string, path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.symlink(targetPath, path, err => {
        if (err) {
          reject(err);
        }
        resolve();
      });
    });
  }

  mkdir(dir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.mkdir(dir, err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async ensureDir(dir: string): Promise<void> {
    // test is root path
    // win: c:/, c://, c:\, c:\\
    // *nix: /
    if (dir === '/' || dir.match(/^[a-zA-Z]:(\/|\\)\1?$/)) {
      return;
    }

    let err;
    try {
      await this.mkdir(dir);
      return;
    } catch (error) {
      // avoid nested code block
      err = error;
    }

    switch (err.code) {
      case 2:
        const parentPath = this.pathResolver.dirname(dir);
        if (parentPath === dir) throw err;
        await this.ensureDir(parentPath);
        await this.mkdir(dir);
        break;

      // In the case of any other error, just see if there's a dir
      // there already.  If so, then hooray!  If not, then something
      // is borked.
      default:
        try {
          const stat = await this.lstat(dir);
          if (stat.type !== FileType.Directory) throw err;
        } catch {
          // if the stat fails, then that's super weird.
          // let the original error be the failure reason
          throw err;
        }
        break;
    }
  }

  list(dir: string): Promise<FileEntry[]> {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(dir, (err, result) => {
        if (err) {
          reject(err);
          return;
        }

        const fileEntries = result.map(item =>
          this.toFileEntry(this.pathResolver.join(dir, item.filename), item)
        );
        resolve(fileEntries);
      });
    });
  }

  unlink(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.unlink(path, err => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  rmdir(path: string, recursive: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!recursive) {
        this.sftp.rmdir(path, err => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
        return;
      }

      this.list(path).then(
        fileEntries => {
          if (!fileEntries.length) {
            this.rmdir(path, false).then(resolve, e => {
              reject(e);
            });
            return;
          }

          const rmPromises = fileEntries.map(file => {
            if (file.type === FileType.Directory) {
              return this.rmdir(file.fspath, true);
            }
            return this.unlink(file.fspath);
          });

          Promise.all(rmPromises)
            .then(() => this.rmdir(path, false))
            .then(resolve, e => {
              // BUG just reject will occur weird bug.
              reject(e);
            });
        },
        err => {
          reject(err);
        }
      );
    });
  }

  private _put(
    input: Readable,
    path,
    option?: {
      flags?: string;
      encoding?: string;
      mode?: number;
      autoClose?: boolean;
      handle?: FileHandle;
    }
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const writer: WriteStream = this.sftp.createWriteStream(path, option);
      writer.once('error', reject).once('finish', resolve); // transffered

      input.once('error', err => {
        reject(err);
        writer.end();
      });
      input.pipe(writer);
    });
  }
}
