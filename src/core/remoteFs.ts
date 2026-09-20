import upath from './upath';
import logger from '../logger';
import {
  CredentialResolver,
  createCredentialResolver,
} from './credentialResolver';
import app from '../app';
import { confirmExposure } from '../modules/passwordExposure';
import {
  noteUpgradeFailed,
  noteUpgradeWorked,
  upgradeIfWorthTrying,
} from '../modules/ftpsUpgrade';
import { isUpgradeTrouble } from './ftpsPolicy';
import { ConnectOption } from './remote-client/remoteClient';
import FileSystem from './fs/fileSystem';
import RemoteFileSystem from './fs/remoteFileSystem';
// Directly, not through `./fs`: the barrel is part of a cycle, and a
// re-exported class read through one can be `undefined` by the time it is
// called.
import SFTPFileSystem from './fs/sftpFileSystem';
import FTPFileSystem from './fs/ftpFileSystem';
import localFs from './localFs';

function hashOption(opiton) {
  return Object.keys(opiton)
    .map(key => opiton[key])
    .join('');
}

class KeepAliveRemoteFs {
  private isValid: boolean = false;
  /** True while this connection is TLS that nobody configured. */
  private _secureByUpgrade: boolean = false;
  /** Rebuilds the file system, for the second attempt after a failed upgrade. */
  private _makeFs: () => RemoteFileSystem;
  private _option: any;
  private _watched: RemoteFileSystem | null = null;

  private pendingPromise: Promise<RemoteFileSystem> | null;

  private fs: RemoteFileSystem;

  async getFs(
    option: ConnectOption & {
      protocol: string;
      remoteTimeOffsetInHours?: number;
      showHiddenFiles?: boolean;
      connectionLimit?: number;
      operationTimeout?: number;
      privateKeyPath?: string;
      passphrase?: string | boolean;
      passwordManager?: string | boolean;
      passphraseManager?: string | boolean;
    }
  ): Promise<RemoteFileSystem> {
    this._option = option;

    if (this.isValid) {
      this.pendingPromise = null;
      return Promise.resolve(this._watching());
    }

    if (this.pendingPromise) {
      return this.pendingPromise;
    }

    const connectOption = Object.assign({}, option);
    // tslint:disable variable-name
    let FsConstructor: typeof SFTPFileSystem | typeof FTPFileSystem;
    if (option.protocol === 'sftp') {
      connectOption.debug = function debug(str) {
        const log = str.match(/^DEBUG(?:\[SFTP\])?: (.*?): (.*?)$/);

        if (log) {
          if (log[1] === 'Parser') return;
          logger.debug(`${log[1]}: ${log[2]}`);
        } else {
          logger.debug(str);
        }
      };
      FsConstructor = SFTPFileSystem;
    } else if (option.protocol === 'ftp') {
      connectOption.debug = function debug(str) {
        const log = str.match(/^\[connection\] (>|<) (.*?)(\\r\\n)?$/);

        if (!log) return;

        if (log[2].match(/200 NOOP/)) return;

        if (log[2].match(/^PASS /)) log[2] = 'PASS ******';

        logger.debug(`${log[1]} ${log[2]}`);
      };
      FsConstructor = FTPFileSystem;
    } else {
      throw new Error(`unsupported protocol ${option.protocol}`);
    }

    // Not an object literal: `showHiddenFiles` and `connectionLimit` are only
    // meaningful to FTP.
    const fsOption = {
      clientOption: connectOption,
      remoteTimeOffsetInHours: option.remoteTimeOffsetInHours,
      showHiddenFiles: option.showHiddenFiles,
      connectionLimit: option.connectionLimit,
      operationTimeout: option.operationTimeout,
    };
    this._makeFs = () => {
      const made = new FsConstructor(upath, fsOption) as RemoteFileSystem;
      made.onDisconnected(this.invalid.bind(this));
      return made;
    };
    this._secureByUpgrade = false;
    this.fs = this._makeFs();

    const credentials = createCredentialResolver({
      protocol: option.protocol,
      host: option.host,
      port: option.port,
      username: option.username,
      privateKeyPath: option.privateKeyPath,
      password: option.password,
      passphrase: option.passphrase,
      passwordCommand: option.passwordCommand,
      passphraseCommand: option.passphraseCommand,
      passwordManager: option.passwordManager,
      passphraseManager: option.passphraseManager,
    });

    app.sftpBarItem.showMsg('connecting...', connectOption.connectTimeout);
    // Assigned in the same tick, so a second caller waits on this attempt
    // instead of starting its own.
    this.pendingPromise = this._connect(credentials, connectOption).then(
      () => {
        app.sftpBarItem.reset();
        this.isValid = true;
        return this._watching();
      },
      err => {
        this.fs.end();
        this.invalid('error');
        throw err;
      }
    );

    return this.pendingPromise;
  }

  private async _connect(
    credentials: CredentialResolver,
    connectOption: any
  ): Promise<void> {
    const resolved = await credentials.resolve();

    if (resolved.password !== undefined) {
      connectOption.password = resolved.password;
    } else if (connectOption.password === true) {
      // Nothing stored yet. Dropping it makes the client ask, and the answer
      // is kept once the server has accepted it.
      delete connectOption.password;
    }

    if (resolved.passphrase !== undefined) {
      connectOption.passphrase = resolved.passphrase;
    }

    // The clients have no use for these, and they shouldn't reach a debug log.
    delete connectOption.passwordCommand;
    delete connectOption.passphraseCommand;
    delete connectOption.passwordManager;
    delete connectOption.passphraseManager;

    // TLS is attempted rather than predicted. If the server cannot manage it,
    // the failure happens here, before anything has been asked of it, and the
    // connection is simply made again as configured.
    const attempt = upgradeIfWorthTrying(connectOption);
    const upgrading = attempt !== connectOption;

    if (upgrading) {
      try {
        await this.fs.connect(attempt, {
          askForPasswd: (message, context) => credentials.ask(message, context),
        });
        noteUpgradeWorked(connectOption);
        this._secureByUpgrade = true;
        await credentials.commit();
        return;
      } catch (error) {
        noteUpgradeFailed(connectOption, error.message);
        // A fresh client: the one that failed the handshake is not reusable.
        this.fs.end();
        this.fs = this._makeFs();
      }
    }

    if (!(await confirmExposure(connectOption))) {
      throw new Error(
        'Cancelled: the password would have been sent in cleartext.'
      );
    }

    try {
      await this.fs.connect(connectOption, {
        askForPasswd: (message, context) => credentials.ask(message, context),
      });
    } catch (error) {
      await credentials.discard(error);
      throw error;
    }

    await credentials.commit();
  }

  /**
   * The file system, or a view of it that notices TLS going wrong.
   *
   * Only wrapped when this connection is encrypted because the extension
   * decided so: a configured connection behaves exactly as it always did, and
   * a plain one has nothing to watch for.
   */
  private _watching(): RemoteFileSystem {
    if (!this._secureByUpgrade) {
      return this.fs;
    }
    if (this._watched) {
      return this._watched;
    }

    const self = this;
    this._watched = new Proxy(this.fs, {
      get(target: any, property: PropertyKey) {
        const value = target[property];
        if (typeof value !== 'function') {
          return value;
        }

        return (...args: any[]) => {
          const answer = value.apply(target, args);

          // Only asynchronous work can fail in the way this is watching for.
          if (!answer || typeof answer.then !== 'function') {
            return answer;
          }

          return answer.then(undefined, (error: any) => {
            self.noteTrouble(self._option, error);
            throw error;
          });
        };
      },
    }) as RemoteFileSystem;

    return this._watched;
  }

  invalid(reason: string) {
    this._watched = null;
    this.pendingPromise = null;
    this.fs.end();
    this.isValid = false;
  }

  /**
   * Something went wrong on a connection this upgraded by itself.
   *
   * The connection is dropped and the server is not tried over TLS again for
   * a while, so the next use reconnects as configured. The error itself still
   * reaches the caller - the transfer layer treats it as transient and tries
   * again, by which point the reconnection has already happened.
   */
  noteTrouble(option: any, error: any): boolean {
    if (!this._secureByUpgrade || !isUpgradeTrouble(error)) {
      return false;
    }

    noteUpgradeFailed(option || this._option, error && error.message);
    this._secureByUpgrade = false;
    this.invalid('tls');

    return true;
  }

  end() {
    this.fs.end();
  }
}

function getLocalFs() {
  return Promise.resolve(localFs);
}

const fsTable: {
  [x: string]: KeepAliveRemoteFs;
} = {};

export function createRemoteIfNoneExist(option): Promise<FileSystem> {
  if (option.protocol === 'local') {
    return getLocalFs();
  }

  const identity = hashOption(option);
  const fs = fsTable[identity];
  if (fs !== undefined) {
    return fs.getFs(option);
  }

  const fsInstance = new KeepAliveRemoteFs();
  fsTable[identity] = fsInstance;
  return fsInstance.getFs(option);
}

export function removeRemoteFs(option) {
  const identity = hashOption(option);
  const fs = fsTable[identity];
  if (fs !== undefined) {
    fs.end();
    delete fsTable[identity];
  }
}
