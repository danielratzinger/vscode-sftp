import upath from './upath';
import logger from '../logger';
import {
  CredentialResolver,
  createCredentialResolver,
} from './credentialResolver';
import app from '../app';
import { confirmExposure } from '../modules/passwordExposure';
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
    if (this.isValid) {
      this.pendingPromise = null;
      return Promise.resolve(this.fs);
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
    this.fs = new FsConstructor(upath, fsOption);
    this.fs.onDisconnected(this.invalid.bind(this));

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

    // Before the socket, not after: a password sent in the clear cannot be
    // taken back once it has gone.
    if (!(await confirmExposure(option))) {
      this.invalid('cancelled');
      throw new Error(
        'Cancelled: the password would have been sent in cleartext.'
      );
    }

    app.sftpBarItem.showMsg('connecting...', connectOption.connectTimeout);
    // Assigned in the same tick, so a second caller waits on this attempt
    // instead of starting its own.
    this.pendingPromise = this._connect(credentials, connectOption).then(
      () => {
        app.sftpBarItem.reset();
        this.isValid = true;
        return this.fs;
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

  invalid(reason: string) {
    this.pendingPromise = null;
    this.fs.end();
    this.isValid = false;
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
