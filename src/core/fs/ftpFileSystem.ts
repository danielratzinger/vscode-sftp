import { Readable } from 'stream';
import logger from '../../logger';
import { FileEntry, FileType, FileStats, FileOption } from './fileSystem';
import RemoteFileSystem, { RFSOption } from './remoteFileSystem';
import ConnectionPool, { PooledConnection } from './ftpConnectionPool';
import {
  isOperationTimeout,
  watchCounter,
  withDeadline,
} from './operationTimeout';
import { isConnectionLost } from './transientError';
import FTPClient from '../remote-client/ftpClient';

export const DEFAULT_CONNECTION_LIMIT = 4;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
/** Timezones move in quarter hours, and nothing finer survives a `LIST`. */
const QUARTER_HOUR = 15 * MINUTE;

/** Below this, a clock difference is ordinary and not worth mentioning. */
const SIGNIFICANT_DRIFT = 2 * MINUTE;

/**
 * A listing older than about six months carries a year instead of a clock
 * time - `Mar 15 2025` rather than `Sep 19 15:40` - and the parser fills the
 * missing time with midnight. Measured against a real `MDTM`, that reads as
 * an offset of minus the file's time of day: a file saved at four in the
 * afternoon makes the server look sixteen hours behind.
 *
 * So the sample has to be recent enough to have been printed with a time.
 */
const LISTING_KEEPS_THE_TIME_FOR = 150 * 24 * HOUR;

export function pickTimeSample(stats: any[], now: number = Date.now()): any {
  const usable = stats.filter(
    item =>
      item &&
      item.name &&
      item.type === '-' &&
      item.date instanceof Date &&
      !isNaN(item.date.getTime()) &&
      now - item.date.getTime() < LISTING_KEEPS_THE_TIME_FOR &&
      // A year-form listing lands exactly on midnight. A file genuinely saved
      // then is possible and rare, and skipping it costs nothing.
      !(item.date.getHours() === 0 && item.date.getMinutes() === 0)
  );

  // The newest, because it is the one most certainly printed with a time.
  return usable.sort((a, b) => b.date.getTime() - a.date.getTime())[0];
}

/** Real UTC offsets run from -12:00 to +14:00, in quarter hours. */
export function isAPlausibleUtcOffset(milliseconds: number): boolean {
  return milliseconds >= -12 * HOUR && milliseconds <= 14 * HOUR;
}

interface FtpFileHandle {
  path: string;
  flags: string;
  mode?: number;
}

type FTPFileSystemOption = RFSOption & {
  showHiddenFiles?: boolean;
  connectionLimit?: number;
  operationTimeout?: number;
};

const numMap = {
  r: 4,
  w: 2,
  x: 1,
};

function toNumMode(rightObj) {
  // some ftp server would reusult rightObj undefined.
  if (!rightObj) return 0o666;

  // tslint:disable-next-line:no-shadowed-variable
  const modeStr = Object.keys(rightObj).reduce((modeStr, key) => {
    const rightStr = rightObj[key];
    let cur = 0;
    for (const char of rightStr) {
      cur += numMap[char];
    }
    return modeStr + cur;
  }, '');

  return parseInt(modeStr, 8);
}

function hasListedEntry(stats: any[]): boolean {
  return stats.some(item => item.name && item.name !== '.' && item.name !== '..');
}

export default class FTPFileSystem extends RemoteFileSystem {
  private _supportMFMT: boolean = true;
  private _clockDrift: number | undefined;
  private _driftMeasured: boolean = false;

  // `undefined` until we've seen how the server reacts to the `-a` flag.
  private _supportListAll: boolean | undefined;
  private _supportSIZE: boolean = true;
  private _timeOffsetProbe: Promise<boolean> | null = null;

  static getFileType(type) {
    if (type === 'd') {
      return FileType.Directory;
    } else if (type === '-') {
      return FileType.File;
    } else if (type === 'l') {
      return FileType.SymbolicLink;
    } else {
      return FileType.Unknown;
    }
  }

  private _pool: ConnectionPool<FTPClient>;

  constructor(pathResolver, option: FTPFileSystemOption) {
    super(pathResolver, option);

    // Opt out for servers that mishandle the `-a` flag in a way we can't detect.
    if (option.showHiddenFiles === false) {
      this._supportListAll = false;
    }

    this._pool = new ConnectionPool<FTPClient>(this.getClient() as FTPClient, {
      limit:
        option.connectionLimit === undefined
          ? DEFAULT_CONNECTION_LIMIT
          : option.connectionLimit,
      connect: () => this._connectSibling(),
      disconnect: client => {
        try {
          client.end();
        } catch (error) {
          logger.debug(`failed to close an ftp connection: ${error.message}`);
        }
      },
    });
  }

  get ftp() {
    return this.getClient().getFsClient();
  }

  end() {
    this._pool.end();
    super.end();
  }

  /**
   * An extra control connection, so transfers can run in parallel. It reuses
   * the credentials the primary connection resolved, prompt included, so the
   * user is never asked twice.
   */
  private async _connectSibling(): Promise<FTPClient> {
    const option = this.getClient().connectOption;
    if (option.password === undefined) {
      throw new Error('no resolved credentials to open another connection with');
    }

    const client = this._createClient(option) as FTPClient;
    await client.connect(option, {
      // Unreachable: the option above already carries the password.
      askForPasswd: () => Promise.resolve(undefined),
    });

    // A dropped sibling has to leave the pool: FTP commands have no timeout,
    // so an operation sent down a half-open connection would just hang.
    client.onDisconnected(() => this._pool.discard(client));

    return client;
  }

  /**
   * Runs `task` on a connection borrowed from the pool. A connection that dies
   * under the task is dropped rather than handed to the next caller.
   *
   * `operation` names the call in a timeout, and `timeout` overrides the
   * deadline - zero for a transfer, which is watched for silence instead of
   * being given a length.
   */
  private async _withClient<T>(
    task: (ftp: any, retire: () => void) => Promise<T>,
    operation: string,
    timeout?: number
  ): Promise<T> {
    const lease = await this._pool.acquire();
    const retire = () => this._retire(lease);

    try {
      return await withDeadline(task(lease.client.getFsClient(), retire), {
        ms: timeout === undefined ? this._operationTimeout : timeout,
        operation,
        onExpire: retire,
      });
    } catch (error) {
      if (isConnectionLost(error)) {
        lease.invalidate();
      }
      throw error;
    } finally {
      this._pool.release(lease);
    }
  }

  /**
   * Retires a connection whose state we no longer know.
   *
   * A command that never answered may still be in flight, so nothing can be
   * sent down this connection again - including `QUIT`, which would queue
   * behind the command that is stuck. The socket is destroyed instead, which
   * turns the stall into the one failure everything above already knows how to
   * recover from: a dropped connection.
   */
  private _retire(lease: PooledConnection<FTPClient>): void {
    lease.invalidate();

    try {
      const raw = lease.client.getFsClient();
      if (raw && typeof raw.destroy === 'function') {
        raw.destroy();
        return;
      }
    } catch (error) {
      // Already gone; the pool drops it on release either way.
    }

    try {
      lease.client.end();
    } catch (error) {
      logger.debug(`failed to close a stalled ftp connection: ${error.message}`);
    }
  }

  toFileStat(stat): FileStats {
    const mtime = this.toLocalTime(stat.date.getTime());
    return {
      type: FTPFileSystem.getFileType(stat.type),
      mode: toNumMode(stat.rights), // Caution: windows will always get 0o666
      size: stat.size,
      mtime,
      atime: mtime,
      target: stat.target,
    };
  }

  toFileEntry(fullPath, stat): FileEntry {
    return {
      fspath: fullPath,
      name: stat.name,
      ...this.toFileStat(stat),
    };
  }

  _createClient(option) {
    return new FTPClient(option);
  }

  async lstat(path: string): Promise<FileStats> {
    if (path === '/') {
      return {
        type: FileType.Directory,
        mode: 0o666,
        size: 0,
        mtime: 0,
        atime: 0,
      };
    }

    const parentPath = this.pathResolver.dirname(path);
    const nameIdentity = this.pathResolver.basename(path);
    const stats = await this.list(parentPath);

    const fileStat = stats.find(ns => ns.name === nameIdentity);

    if (!fileStat) {
      throw new Error('file not exist');
    }

    return fileStat;
  }

  open(path: string, flags: string, mode?: number): Promise<FtpFileHandle> {
    return Promise.resolve({
      path,
      flags,
      mode,
    });
  }

  close(_fd: FtpFileHandle): Promise<void> {
    return Promise.resolve();
  }

  fstat(fd: FtpFileHandle): Promise<FileStats> {
    return this.lstat(fd.path);
  }

  futimes(fd: FtpFileHandle, atime: number, mtime: number): Promise<void> {
    return this.utimes(fd.path, atime, mtime);
  }

  utimes(path: string, _atime: number, mtime: number): Promise<void> {
    if (!this._supportMFMT) {
      // The file this extension just wrote kept the server's own timestamp,
      // which is the one chance to see what the server thinks the time is.
      this._measureClockDrift(path);
      return Promise.resolve();
    }

    return this.atomicSetLastMod(path, new Date(mtime * 1000)).catch(_ => {
      logger.info('Don\'t Support MFMT');
      this._supportMFMT = false;
    });
  }

  /** How far the server's clock is from this machine's, once it is known. */
  get clockDrift(): number | undefined {
    return this._clockDrift;
  }

  /**
   * What the server thinks the time is, from a file it has just stamped.
   *
   * The timezone measurement cannot see this. It compares two readings of one
   * file taken from the same clock, so a clock that is wrong is wrong in both
   * and cancels out; what is left is the timezone. A drifting clock only
   * shows when the server stamps something *now* and says so.
   *
   * That happens for free on servers without `MFMT`: this extension cannot
   * set the timestamp on what it uploads, so the file carries the server's
   * own idea of the time, and `MDTM` reports it in UTC - no timezone in the
   * way. One command, once per connection, on a file that was going to be
   * written anyway.
   *
   * It is reported, not corrected. A clock that is minutes out is a server to
   * fix rather than an offset to carry, and silently compensating would hide
   * it - while making every timestamp on that server depend on a guess.
   */
  private _measureClockDrift(path: string): void {
    if (this._clockDrift !== undefined || this._driftMeasured) {
      return;
    }
    this._driftMeasured = true;

    const writtenAt = Date.now();

    this._withClient(
      ftp =>
        new Promise<Date>((resolve, reject) => {
          ftp.lastMod(path, (err, date) => (err ? reject(err) : resolve(date)));
        }),
      `MDTM ${path}`
    )
      .then(stamped => {
        if (!(stamped instanceof Date) || isNaN(stamped.getTime())) {
          return;
        }

        // `lastMod` builds its Date from an ISO string with no zone, so the
        // reading is the server's UTC digits placed in local time. Reading
        // this machine's clock the same way makes the two comparable.
        const here = new Date(writtenAt);
        const asLocal = Date.UTC(
          here.getUTCFullYear(),
          here.getUTCMonth(),
          here.getUTCDate(),
          here.getUTCHours(),
          here.getUTCMinutes(),
          here.getUTCSeconds()
        );
        const theirs = Date.UTC(
          stamped.getFullYear(),
          stamped.getMonth(),
          stamped.getDate(),
          stamped.getHours(),
          stamped.getMinutes(),
          stamped.getSeconds()
        );

        this._clockDrift = theirs - asLocal;

        if (Math.abs(this._clockDrift) < SIGNIFICANT_DRIFT) {
          return;
        }

        const minutes = Math.round(this._clockDrift / MINUTE);
        logger.warn(
          `The server's clock is ${Math.abs(minutes)} minutes ` +
            `${minutes > 0 ? 'ahead of' : 'behind'} this machine. Files changed ` +
            'on the server by anything other than this extension will look ' +
            `that much ${minutes > 0 ? 'newer' : 'older'} than they are, so ` +
            'comparisons against local copies can be wrong. This is the ' +
            'server\'s clock rather than its timezone, and is worth fixing ' +
            'there rather than working around here.'
        );
      })
      .catch(() => {
        // A server that will not answer MDTM tells us nothing; nothing here
        // is worth failing a transfer over.
      });
  }

  async get(path, _option?: FileOption): Promise<Readable> {
    const stream = await this.atomicGet(path);

    if (!stream) {
      throw new Error('create ReadStream failed');
    }

    return stream;
  }

  /**
   * Works out how far the server's clock reads from this machine's, so the
   * timestamps in a listing can be compared with local ones.
   *
   * A `LIST` line carries no timezone: it is the server's wall clock, and
   * node-ftp reads it as if it were ours. `MDTM` returns the same moment in
   * UTC, and node-ftp reads that as ours too. Both are shifted by our own
   * offset, so what is left between them is the server's - no clock reading,
   * no writing to the server, one extra command per connection.
   */
  private async _measureTimeOffset(dir: string, stats: any[]): Promise<boolean> {
    const sample = pickTimeSample(stats);
    if (!sample) {
      // Nothing here can be measured against; the next directory might have
      // something.
      return false;
    }

    const samplePath = this.pathResolver.join(dir, sample.name);

    let asUtc: Date;
    try {
      asUtc = await this._withClient(
        ftp =>
          new Promise<Date>((resolve, reject) => {
            ftp.lastMod(samplePath, (err, date) => {
              if (err) {
                return reject(err);
              }

              resolve(date);
            });
          }),
        `MDTM ${samplePath}`
      );
    } catch (error) {
      logger.info(
        `Can't measure the server's time offset (${error.message}); assuming none.`
      );
      return true;
    }

    if (!(asUtc instanceof Date) || isNaN(asUtc.getTime())) {
      logger.info('The server gave no usable MDTM time; assuming no offset.');
      return true;
    }

    // Both dates come back parsed as local time - node-ftp builds the MDTM
    // one from an ISO string with no `Z` - so the difference between them is
    // the server's own UTC offset, with the local one cancelling out.
    const serverOffset = sample.date.getTime() - asUtc.getTime();

    if (!isAPlausibleUtcOffset(serverOffset)) {
      // Nothing between -12:00 and +14:00 is a timezone, so this is a
      // measurement rather than an offset: usually a listing that gave a date
      // without a time, whose midnight is being compared against a real one.
      logger.info(
        `The server's time offset measured ${(serverOffset / HOUR).toFixed(2)} ` +
          'hours, which is not a timezone; ignoring it. Set ' +
          'remoteTimeOffsetInHours if timestamps here need correcting.'
      );
      return true;
    }

    const localOffset = -sample.date.getTimezoneOffset() * MINUTE;
    const measured = serverOffset - localOffset;
    const rounded = Math.round(measured / QUARTER_HOUR) * QUARTER_HOUR;

    if (rounded === 0) {
      logger.info('The server keeps the same time as this machine.');
      return true;
    }

    logger.info(
      `The server's timestamps run ${rounded / HOUR} hours from local time ` +
        `(measured ${(measured / HOUR).toFixed(2)}); correcting for it. ` +
        'Set remoteTimeOffsetInHours to override.'
    );
    this.setRemoteTimeOffsetInHours(rounded / HOUR);

    return true;
  }

  /**
   * `SIZE` costs one round trip; `lstat` would list the whole parent directory.
   * Returns `undefined` rather than throwing when the server won't answer, so
   * a server without `SIZE` doesn't turn into a wall of failed transfers.
   */
  async size(path: string): Promise<number | undefined> {
    if (!this._supportSIZE) {
      return undefined;
    }

    try {
      return await this._withClient(
        ftp =>
          new Promise<number>((resolve, reject) => {
            ftp.size(path, (err, bytes) => {
              if (err) {
                return reject(err);
              }

              resolve(bytes);
            });
          }),
        `SIZE ${path}`
      );
    } catch (error) {
      // Only "command not implemented" says anything about the server; a 550
      // is about this one path and must not disable the check everywhere.
      if (error.code === 500 || error.code === 502) {
        logger.info('Don\'t Support SIZE');
        this._supportSIZE = false;
      }

      return undefined;
    }
  }

  async chmod(path: string, mode: number): Promise<void> {
    const command = `CHMOD ${mode.toString(8)} ${path}`;
    return await this.atomicSite(command);
  }

  async put(input: Readable, path, _option?: FileOption): Promise<void> {
    let inputError: Error | undefined;

    return this._withClient(
      async (ftp, retire) => {
        const onInputError = err => {
          inputError = err;
          // Abort on this transfer's own connection, not on whichever one
          // happens to be primary.
          ftp.abort(abortErr => {
            if (abortErr) {
              logger.error(abortErr, 'fail to abort');
            }
          });
        };

        input.once('error', onInputError);
        try {
          await new Promise<void>((resolve, reject) => {
            // Read from the counter the stream already keeps. Listening for
            // `data` would start it flowing before node-ftp has piped it, and
            // the bytes emitted in between would never reach the server.
            const watchdog = watchCounter(
              () => (input as any).bytesRead,
              this._operationTimeout,
              `upload ${path}`,
              error => {
                // The reply to STOR is not coming, so the caller is answered
                // here rather than waiting for a callback that is stuck too.
                retire();
                reject(error);
              }
            );

            ftp.put(input, path, err => {
              watchdog.stop();
              if (err) {
                return reject(err);
              }

              resolve();
            });
          });
        } catch (error) {
          throw inputError || error;
        } finally {
          input.removeListener('error', onInputError);
        }
      },
      `upload ${path}`,
      // A transfer has no length that is correct; it is watched for silence.
      0
    );
  }

  readlink(path: string): Promise<string> {
    return this.lstat(path).then(stat => stat.target!);
  }

  symlink(_targetPath: string, _path: string): Promise<void> {
    // TO-DO implement
    return Promise.resolve();
  }

  async mkdir(dir: string): Promise<void> {
    return await this.atomicMakeDir(dir);
  }

  async ensureDir(dir: string): Promise<void> {
    return await this._ensureDir(dir, true);
  }

  async _ensureDir(dir: string, checkExistFirst: boolean): Promise<void> {
    // check if exist first.
    // `ls` command can't make sure to return dotfiles, so this not work for dotfiles,
    // cause ftp don't return distinct error code for dir not exists and dir exists
    if (checkExistFirst) {
      let stat;
      try {
        stat = await this.lstat(dir);
      } catch {
        // ignore error
      }

      if (stat) {
        if (stat.type !== FileType.Directory) {
          logger.error(`${dir} (type = ${stat.type})is not a directory`);
          throw new Error(`${dir} is not a valid directory path`);
        }

        return;
      }
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
      case 550:
        // Hooray, exists!
        if (err.message.toLowerCase().indexOf('file exists') >= 0) {
          return;
        }

        const parentPath = this.pathResolver.dirname(dir);
        // We are trying to create the root dir, something must go wrong.
        if (parentPath === dir) {
          throw err;
        }

        // If goes here, we can assume the file doesn't exist
        await this._ensureDir(parentPath, false);
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

  async list(dir: string): Promise<FileEntry[]> {
    const stats = await this.atomicList(dir);

    // Before the entries are converted, so the first listing is already
    // corrected rather than the one after it.
    if (!this.hasConfiguredTimeOffset && this._timeOffsetProbe === null) {
      this._timeOffsetProbe = this._measureTimeOffset(dir, stats);
    }

    if (this._timeOffsetProbe !== null) {
      const settled = await this._timeOffsetProbe;
      if (!settled) {
        // This directory had nothing to measure against; the next one might.
        this._timeOffsetProbe = null;
      }
    }

    return (
      stats
        // item will be a string if ftp fail to parse it (https://github.com/liximomo/vscode-sftp/issues/308)
        // we simply ignore it by check whether it has a name property
        .filter(item => item.name && item.name !== '.' && item.name !== '..')
        .map(item =>
          this.toFileEntry(this.pathResolver.join(dir, item.name), item)
        )
    );
  }

  async unlink(path: string): Promise<void> {
    return await this.atomicDeleteFile(path);
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    return await this.atomicRemoveDir(path, recursive);
  }

  async rename(srcPath: string, destPath: string): Promise<void> {
    return await this.renameAtomic(srcPath, destPath);
  }

  async renameAtomic(srcPath: string, destPath: string): Promise<void> {
    return this._withClient(
      ftp =>
        new Promise<void>((resolve, reject) => {
          ftp.rename(srcPath, destPath, err => {
            if (err) {
              return reject(err);
            }

            resolve();
          });
        }),
      `RNTO ${destPath}`
    );
  }

  /**
   * A bare `LIST` omits dotfiles on most servers, so ask for `LIST -a` and
   * remember whether the server understood it.
   */
  private async atomicList(path: string): Promise<any[]> {
    if (this._supportListAll === false) {
      return this._rawList(path);
    }

    // A server that splits the argument on whitespace can't be probed with
    // such a path, so what happens with it tells us nothing about the server.
    const canProbe = !/\s/.test(path);

    let stats: any[];
    try {
      stats = await this._rawList(`-a ${path}`);
    } catch (error) {
      // A stall or a dropped connection is about the connection, not about the
      // flag. Reading it as a verdict would switch hidden files off for the
      // rest of the session on the strength of one bad moment.
      if (isOperationTimeout(error) || isConnectionLost(error)) {
        throw error;
      }

      if (this._supportListAll && canProbe) {
        throw error;
      }

      if (canProbe) {
        this._supportListAll = false;
        logger.info('Don\'t Support LIST -a');
      }
      return this._rawList(path);
    }

    if (this._supportListAll || hasListedEntry(stats)) {
      if (canProbe) {
        this._supportListAll = true;
      }
      return stats;
    }

    // An empty result means either an empty directory or a server that took
    // `-a <path>` for a file name. A plain `LIST` tells the two apart.
    const fallbackStats = await this._rawList(path);
    if (hasListedEntry(fallbackStats)) {
      if (canProbe) {
        this._supportListAll = false;
        logger.info('Don\'t Support LIST -a');
      }
      return fallbackStats;
    }

    return stats;
  }

  private async _rawList(path: string): Promise<any[]> {
    return this._withClient(
      ftp =>
        new Promise<any[]>((resolve, reject) => {
          ftp.list(path, (err, stats) => {
            if (err) {
              return reject(err);
            }

            resolve(stats || []);
          });
        }),
      `LIST ${path}`
    );
  }

  /**
   * Unlike the other operations this one can't use `_withClient`: node-ftp
   * hands the stream over as soon as the data connection opens, while the
   * connection stays busy until the last byte. Releasing it there would let a
   * second transfer queue up behind this one on the same connection.
   */
  private async atomicGet(path: string): Promise<Readable> {
    const lease = await this._pool.acquire();

    let stream: Readable;
    try {
      stream = await withDeadline(
        new Promise<Readable>((resolve, reject) => {
          lease.client.getFsClient().get(path, (err, result) => {
            if (err) {
              return reject(err);
            }

            resolve(result);
          });
        }),
        {
          // Opening the data connection is a command like any other. What
          // comes down it afterwards is watched for silence instead.
          ms: this._operationTimeout,
          operation: `RETR ${path}`,
          onExpire: () => this._retire(lease),
        }
      );
    } catch (error) {
      if (isConnectionLost(error)) {
        lease.invalidate();
      }
      this._pool.release(lease);
      throw error;
    }

    this._releaseWhenDrained(stream, lease, path);

    return stream;
  }

  private _releaseWhenDrained(
    stream: Readable,
    lease: PooledConnection<FTPClient>,
    path: string
  ): void {
    let released = false;

    // The socket counts what it has read, so silence can be noticed without
    // touching the stream the consumer is about to pipe.
    const watchdog = watchCounter(
      () => (stream as any).bytesRead,
      this._operationTimeout,
      `download ${path}`,
      error => {
        this._retire(lease);
        // The consumer is mid-pipe and would otherwise wait for bytes that
        // are not coming; an error on the stream is how it finds out.
        if (typeof (stream as any).destroy === 'function') {
          (stream as any).destroy(error);
        } else {
          stream.emit('error', error);
        }
      }
    );

    const release = (error?: Error) => {
      if (released) {
        return;
      }
      released = true;
      watchdog.stop();

      if (error && isConnectionLost(error)) {
        lease.invalidate();
      }
      this._pool.release(lease);
    };

    // 'close' covers a consumer that gives up without reading to the end.
    stream.once('end', () => release());
    stream.once('close', () => release());
    stream.once('error', release);
  }

  private async atomicDeleteFile(path: string): Promise<void> {
    return this._withClient(
      ftp =>
        new Promise<void>((resolve, reject) => {
          ftp.delete(path, err => {
            if (err) {
              return reject(err);
            }

            resolve();
          });
        }),
      `DELE ${path}`
    );
  }

  private async atomicMakeDir(path: string): Promise<void> {
    return this._withClient(
      ftp =>
        new Promise<void>((resolve, reject) => {
          ftp.mkdir(path, err => {
            if (err) {
              return reject(err);
            }

            resolve();
          });
        }),
      `MKD ${path}`
    );
  }

  private async atomicRemoveDir(
    path: string,
    recursive: boolean
  ): Promise<void> {
    return this._withClient(
      ftp =>
        new Promise<void>((resolve, reject) => {
          ftp.rmdir(path, recursive, err => {
            if (err) {
              return reject(err);
            }

            resolve();
          });
        }),
      `RMD ${path}`
    );
  }

  private async atomicSite(command: string): Promise<void> {
    return this._withClient(
      ftp =>
        new Promise<void>((resolve, reject) => {
          ftp.site(command, err => {
            if (err) {
              return reject(err);
            }

            resolve();
          });
        }),
      `SITE ${command}`
    );
  }

  private async atomicSetLastMod(path: string, date: Date): Promise<void> {
    return this._withClient(
      ftp =>
        new Promise<void>((resolve, reject) => {
          ftp.setLastMod(path, date, err => {
            if (err) {
              return reject(err);
            }

            resolve();
          });
        }),
      `MFMT ${path}`
    );
  }
}
