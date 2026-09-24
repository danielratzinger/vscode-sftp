import upath from './upath';
import logger, { withConnection } from '../logger';
import connectionLabel from './connectionLabel';
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
import { watched } from './fs/watched';
// Directly, not through `./fs`: the barrel is part of a cycle, and a
// re-exported class read through one can be `undefined` by the time it is
// called.
import SFTPFileSystem from './fs/sftpFileSystem';
import FTPFileSystem from './fs/ftpFileSystem';
import localFs from './localFs';
import { identityOf } from './connectionIdentity';

class KeepAliveRemoteFs {
  private isValid: boolean = false;
  /** What the logs call this connection. */
  private _name?: string;
  /** True while this connection is TLS that nobody configured. */
  private _secureByUpgrade: boolean = false;
  /** Rebuilds the file system, for the second attempt after a failed upgrade. */
  private _makeFs: () => RemoteFileSystem;
  private _option: any;
  private _watched: RemoteFileSystem | null = null;

  private pendingPromise: Promise<RemoteFileSystem> | null;

  /**
   * Which life of this connection we are in.
   *
   * Ending one and opening one are not ordered: `end` can land while a connect
   * is still in flight, and that connect then resolves and sets `isValid` on an
   * instance whose socket is gone. Everything afterwards is handed a connection
   * that says it is fine and answers nothing. Clearing `pendingPromise` in
   * `end` was half of the fix and made that outcome more likely, not less -
   * before it, a second caller at least waited on the same doomed promise.
   *
   * A counter rather than a flag, because an instance is reused: `getFs`
   * reconnects after an end, and the number tells a late answer which life it
   * belongs to.
   */
  private _generation = 0;

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
    },
    name?: string
  ): Promise<RemoteFileSystem> {
    this._option = option;
    this._name = this._name || name || connectionLabel(option as any);

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
      passwordWriteCommand: (option as any).passwordWriteCommand,
      passphraseWriteCommand: (option as any).passphraseWriteCommand,
      passwordManager: option.passwordManager,
      passphraseManager: option.passphraseManager,
      name: (option as any).connectionName,
    });

    app.sftpBarItem.showMsg('connecting...', connectOption.connectTimeout);
    // Which life this attempt belongs to, so an answer that arrives after the
    // connection was ended cannot report success on a dead socket.
    const generation = this._generation;
    // Assigned in the same tick, so a second caller waits on this attempt
    // instead of starting its own.
    this.pendingPromise = withConnection(this._name, () =>
      this._connect(credentials, connectOption)
    ).then(
      () => {
        if (generation !== this._generation) {
          this.fs.end();
          throw new Error(
            'the connection was closed while it was being opened; try again'
          );
        }

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
    delete connectOption.passwordWriteCommand;
    delete connectOption.passphraseWriteCommand;
    delete connectOption.passwordManager;
    delete connectOption.passphraseManager;
    delete connectOption.connectionName;

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
   * The file system, as a view that knows which connection it is.
   *
   * Every call runs inside the connection's name, which is how a line logged
   * four frames deep in a client library ends up saying whose server it was.
   * The same wrapper notices an upgraded connection failing, which can only be
   * seen from out here, where the failure and the decision to upgrade both are.
   */
  private _watching(): RemoteFileSystem {
    if (this._watched) {
      return this._watched;
    }

    this._watched = watched(this.fs, {
      name: this._name,
      onTrouble: error => this.noteTrouble(this._option, error),
    });

    return this._watched;
  }

  invalid(reason: string) {
    this._generation += 1;
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

  /**
   * Ends the connection and stops claiming to be usable.
   *
   * `invalid` has always cleared these; this did not, and the difference
   * mattered the moment anything still held the instance. Saving `sftp.json`
   * ends every filesystem for that workspace, and one left saying `isValid`
   * with a dead socket - or holding a `pendingPromise` for a connect that will
   * now never settle - hands that promise to every later caller. A folder in
   * the Remote Explorer then spins for ever and the connection stops
   * answering, which is exactly what changing `remotePath` while connected
   * did.
   */
  end() {
    this._generation += 1;
    this._watched = null;
    this.pendingPromise = null;
    this.isValid = false;
    this.fs.end();
  }
}

function getLocalFs() {
  return Promise.resolve(localFs);
}

const fsTable: {
  [x: string]: KeepAliveRemoteFs;
} = {};

/**
 * `name` is only what the logs should call this connection. It is deliberately
 * not part of the identity: two configurations that reach the same host with
 * the same credentials share one connection, and always have.
 */
export function createRemoteIfNoneExist(
  option,
  name?: string
): Promise<FileSystem> {
  if (option.protocol === 'local') {
    return getLocalFs();
  }

  const identity = identityOf(option);
  const fs = fsTable[identity];
  if (fs !== undefined) {
    return fs.getFs(option, name);
  }

  const fsInstance = new KeepAliveRemoteFs();
  fsTable[identity] = fsInstance;
  return fsInstance.getFs(option, name);
}

export function removeRemoteFs(option) {
  const identity = identityOf(option);
  const fs = fsTable[identity];
  if (fs !== undefined) {
    fs.end();
    delete fsTable[identity];
  }
}
