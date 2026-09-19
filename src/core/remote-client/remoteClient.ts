import CustomError from '../customError';
import { PromptContext } from '../credentialResolver';

export interface ConnectOption {
  // common
  host: string;
  port: number;
  username?: string;
  /** `true` means "don't keep it here" - it's resolved before connecting. */
  password?: string | boolean;
  /** Shell command whose output is the password. */
  passwordCommand?: string;
  /** Shell command whose output is the private key passphrase. */
  passphraseCommand?: string;
  /** Where the credential lives: true for the built-in store, or a manager name. */
  passwordManager?: string | boolean;
  passphraseManager?: string | boolean;
  connectTimeout?: number;
  debug(x: string): void;

  // ssh-only
  privateKeyPath?: string;
  privateKey?: string;
  passphrase?: string | boolean;
  interactiveAuth?: boolean | string[];
  agent?: string;
  sock?: any;
  hop?: ConnectOption | ConnectOption[];
  limitOpenFilesOnRemote?: boolean | number;

  // ftp-only
  secure?: any;
  secureOptions?: object;
  passive?: boolean;
}

export enum ErrorCode {
  CONNECT_CANCELLED,
}

export interface Config {
  askForPasswd(msg: string, context?: PromptContext): Promise<string | undefined>;
}

export default abstract class RemoteClient {
  protected _client: any;
  protected _option: ConnectOption;

  constructor(option: ConnectOption) {
    this._option = option;
    this._client = this._initClient();
  }

  abstract end(): void;
  abstract getFsClient(): any;
  protected abstract _doConnect(connectOption: ConnectOption, config: Config): Promise<void>;
  protected abstract _hasProvideAuth(connectOption: ConnectOption): boolean;
  protected abstract _initClient(): any;

  /**
   * The option this client actually connected with, including a password the
   * user was prompted for. Opening a sibling connection with it doesn't prompt
   * again.
   */
  get connectOption(): ConnectOption {
    return this._option;
  }

  async connect(connectOption: ConnectOption, config: Config) {
    if (this._hasProvideAuth(connectOption)) {
      this._option = connectOption;
      return this._doConnect(connectOption, config);
    }

    const password = await config.askForPasswd(
      `[${connectOption.host}]: Enter your password`,
      { kind: 'password', host: connectOption.host }
    );

    // cancel connect
    if (password === undefined) {
      throw new CustomError(ErrorCode.CONNECT_CANCELLED, 'cancelled');
    }

    const resolvedOption = { ...connectOption, password };
    this._option = resolvedOption;

    return this._doConnect(resolvedOption, config);
  }

  onDisconnected(cb) {
    this._client
      .on('end', () => {
        cb('end');
      })
      .on('close', () => {
        cb('close');
      })
      .on('error', err => {
        cb('error');
      });
  }
}
