import logger from '../logger';
import { buildProviderInvocation } from './credentialProviders';

export type CredentialKind = 'password' | 'passphrase' | 'interactive';

export interface PromptContext {
  kind: CredentialKind;
  /** Host being authenticated against, which is not always the configured one. */
  host?: string;
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CredentialSource {
  protocol: string;
  host: string;
  port: number;
  username?: string;
  privateKeyPath?: string;
  password?: string | boolean;
  passphrase?: string | boolean;
  passwordCommand?: string;
  passphraseCommand?: string;
  /**
   * Where the credential lives. `true` (the default) is the built-in store,
   * `false` is nowhere - ask every time - and a string names a manager,
   * optionally with a reference: "1password:op://...".
   */
  passwordManager?: string | boolean;
  passphraseManager?: string | boolean;
}

export interface CredentialDeps {
  store: SecretStore;
  prompt(message: string): Promise<string | undefined>;
  /** Runs a shell command line the user wrote themselves. */
  runCommand(command: string): Promise<string>;
  /** Runs a program directly, with no shell to quote for. */
  runProgram(argv: string[]): Promise<string>;
  /**
   * The store behind a manager we can write to, or undefined for one we can
   * only read from.
   */
  storeFor(manager: string | boolean): SecretStore | undefined;
  /** What a connection that names no manager of its own falls back to. */
  defaultManager(kind: 'password' | 'passphrase'): string | boolean;
}

export interface ResolvedCredentials {
  password?: string;
  passphrase?: string;
}

const NO_STORE: SecretStore = {
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(),
};

const NOT_AVAILABLE = () =>
  Promise.reject(new Error('Running credential commands is not available.'));

let deps: CredentialDeps = {
  store: NO_STORE,
  prompt: () => Promise.resolve(undefined),
  runCommand: NOT_AVAILABLE,
  runProgram: NOT_AVAILABLE,
  storeFor: manager => (manager === true ? NO_STORE : undefined),
  defaultManager: () => true,
};

export function configureCredentials(next: CredentialDeps) {
  deps = next;
}

/**
 * Whether the server turned us away, as opposed to failing to answer at all.
 * A stored secret that produces this is worth forgetting; anything else is
 * not the secret's fault.
 */
export function isAuthFailure(error: any): boolean {
  if (!error) {
    return false;
  }

  // FTP: 530 Not logged in.
  if (error.code === 530) {
    return true;
  }

  return /all configured authentication methods failed|permission denied|authentication fail|login (incorrect|failed)|not logged in/i.test(
    error.message || ''
  );
}

/**
 * What Keychain Access shows in its "Name" column. Passwords and key
 * passphrases are split so a list of them reads sensibly.
 */
export const KEYCHAIN_SERVICE_PASSWORD = 'vscode-sftp';
export const KEYCHAIN_SERVICE_PASSPHRASE = 'vscode-sftp-passphrase';

export interface KeychainItem {
  service: string;
  account: string;
  label: string;
}

/**
 * Turns one of the keys below into the item a credential lives in. Shared so
 * the built-in Keychain store and a `keychain` provider agree on where to look.
 */
export function toKeychainItem(key: string): KeychainItem {
  const separator = key.indexOf(':');
  const kind = separator === -1 ? 'password' : key.slice(0, separator);
  const id = separator === -1 ? key : key.slice(separator + 1);

  if (kind === 'passphrase') {
    return {
      service: KEYCHAIN_SERVICE_PASSPHRASE,
      account: id,
      label: `SFTP key passphrase: ${id}`,
    };
  }

  return {
    service: KEYCHAIN_SERVICE_PASSWORD,
    account: id,
    label: `SFTP: ${id}`,
  };
}

function accountKey(source: CredentialSource): string {
  return `${source.protocol}://${source.username || ''}@${source.host}:${
    source.port
  }`;
}

export function passwordKeyFor(source: CredentialSource): string {
  return `password:${accountKey(source)}`;
}

/**
 * A passphrase unlocks a key file, not a host, so it's keyed by the file when
 * we know it. The same key used for ten servers is asked for once.
 */
export function passphraseKeyFor(source: CredentialSource): string {
  return `passphrase:${source.privateKeyPath || accountKey(source)}`;
}

/**
 * Works out where a connection's password and passphrase come from, and
 * remembers the ones the user typed once the server has accepted them.
 *
 * Nothing is written before a connection succeeds, so a mistyped password
 * doesn't get saved, and a stored one the server rejects is dropped again.
 */
export class CredentialResolver {
  private _source: CredentialSource;
  private _deps: CredentialDeps;
  private _pending: { password?: string; passphrase?: string } = {};
  private _usedStored: { password?: boolean; passphrase?: boolean } = {};

  constructor(source: CredentialSource, dependencies: CredentialDeps) {
    this._source = source;
    this._deps = dependencies;
  }

  get passwordKey(): string {
    return passwordKeyFor(this._source);
  }

  get passphraseKey(): string {
    return passphraseKeyFor(this._source);
  }

  /**
   * Values to fold into the connect option. A credential that is missing here
   * is left for the prompt, which is what `true` in the config asks for.
   */
  async resolve(): Promise<ResolvedCredentials> {
    // Turning a manager off is also an instruction to clean up, so a secret
    // kept from when it was on doesn't sit there unused.
    await this._purgeSwitchedOff();

    const resolved: ResolvedCredentials = {};

    const password = await this._resolveOne(
      this._source.password,
      this._source.passwordCommand,
      this._managerFor('password'),
      this.passwordKey,
      'password'
    );
    if (password !== undefined) {
      resolved.password = password;
    }

    const passphrase = await this._resolveOne(
      this._source.passphrase,
      this._source.passphraseCommand,
      this._managerFor('passphrase'),
      this.passphraseKey,
      'passphrase'
    );
    if (passphrase !== undefined) {
      resolved.passphrase = passphrase;
    }

    return resolved;
  }

  /**
   * Prompts, and holds on to the answer until the connection proves it right.
   */
  async ask(
    message: string,
    context: PromptContext = { kind: 'password' }
  ): Promise<string | undefined> {
    const value = await this._deps.prompt(message);
    if (value === undefined) {
      return undefined;
    }

    // Hops authenticate against other hosts, and their secrets aren't ours to
    // keep. Keyboard-interactive answers are usually one-time codes.
    const isOurs = !context.host || context.host === this._source.host;
    if (!isOurs || context.kind === 'interactive') {
      return value;
    }

    // Nowhere to put it is not a failure; it just means asking again next time.
    if (this._storeFor(context.kind)) {
      this._pending[context.kind] = value;
    }

    return value;
  }

  /** Persist what was typed. Call once the connection is up. */
  async commit(): Promise<void> {
    await this._store('password', this.passwordKey, this._pending.password);
    await this._store('passphrase', this.passphraseKey, this._pending.passphrase);
    this._pending = {};
  }

  /** The store a credential of this kind belongs in, for callers outside. */
  storeForKind(kind: 'password' | 'passphrase'): SecretStore | undefined {
    return this._storeFor(kind);
  }

  /**
   * Forget a stored secret the server rejected, so the next attempt asks
   * again instead of failing the same way forever.
   */
  async discard(error: any): Promise<void> {
    this._pending = {};

    if (!isAuthFailure(error)) {
      return;
    }

    if (this._usedStored.password) {
      await this._forget(this.passwordKey, 'the server rejected it');
    }
    if (this._usedStored.passphrase) {
      await this._forget(this.passphraseKey, 'the server rejected it');
    }
  }

  private async _resolveOne(
    configured: string | boolean | undefined,
    command: string | undefined,
    manager: string | boolean,
    key: string,
    kind: 'password' | 'passphrase'
  ): Promise<string | undefined> {
    if (command) {
      const value = await this._deps.runCommand(command);
      if (!value) {
        throw new Error(`The ${kind} command produced no output.`);
      }
      return value;
    }

    // A manager we can only read from is the whole answer: there is nowhere
    // to put a literal, so it would only ever go stale.
    if (typeof manager === 'string' && !this._deps.storeFor(manager)) {
      const invocation = buildProviderInvocation(manager, toKeychainItem(key));
      const output = await this._deps.runProgram(invocation.argv);
      const value = invocation.firstLineOnly ? output.split('\n')[0] : output;

      if (!value) {
        throw new Error(
          `The ${kind} manager "${manager}" returned nothing for this connection.`
        );
      }

      if (typeof configured === 'string') {
        logger.warn(
          `The ${kind} for ${this._source.host} is still written in the config ` +
            `file, and "${manager}" can't be written to, so it can't be moved ` +
            'there automatically. Remove it by hand once you have stored it.'
        );
      }

      return value;
    }

    const stored = await this._readStored(key, kind);
    if (stored !== undefined) {
      return stored;
    }

    // Nothing stored yet. A literal is what gets us connected this once, and
    // is then moved into the store.
    if (typeof configured === 'string') {
      return configured;
    }

    return undefined;
  }

  private async _readStored(
    key: string,
    kind: 'password' | 'passphrase'
  ): Promise<string | undefined> {
    const store = this._storeFor(kind);
    if (!store) {
      return undefined;
    }

    let stored: string | undefined;
    try {
      stored = await store.get(key);
    } catch (error) {
      logger.warn(`Can't read the stored ${kind}: ${error.message}`);
      return undefined;
    }

    if (stored !== undefined) {
      this._usedStored[kind] = true;
    }

    return stored;
  }

  /**
   * What this connection asked for, or the setting it falls back to.
   */
  private _managerFor(kind: 'password' | 'passphrase'): string | boolean {
    const configured =
      kind === 'password'
        ? this._source.passwordManager
        : this._source.passphraseManager;

    return configured === undefined
      ? this._deps.defaultManager(kind)
      : configured;
  }

  /**
   * The store this kind's manager names, or the built-in one. `false` means
   * there isn't one: ask every time and keep nothing.
   */
  private _storeFor(kind: 'password' | 'passphrase'): SecretStore | undefined {
    const manager = this._managerFor(kind);

    if (manager === false) {
      return undefined;
    }

    if (manager === true) {
      return this._deps.store;
    }

    return this._deps.storeFor(manager);
  }

  private async _store(
    kind: 'password' | 'passphrase',
    key: string,
    value: string | undefined
  ): Promise<void> {
    if (value === undefined) {
      return;
    }

    const store = this._storeFor(kind);
    if (!store) {
      logger.warn(`There is nowhere to save the ${kind} for ${this._source.host}.`);
      return;
    }

    try {
      await store.set(key, value);
      logger.info(`Saved the ${kind} for ${this._source.host}.`);
    } catch (error) {
      logger.warn(`Can't save the ${kind}: ${error.message}`);
    }
  }

  private async _forget(key: string, reason: string): Promise<void> {
    try {
      await this._deps.store.delete(key);
      logger.info(`Forgot the stored secret for ${this._source.host}: ${reason}.`);
    } catch (error) {
      logger.warn(`Can't forget a stored secret: ${error.message}`);
    }
  }

  /**
   * Drop what was kept for a credential whose manager has since been turned
   * off. Checks first, so a connection that never stored anything doesn't
   * announce a deletion on every connect.
   */
  private async _purgeSwitchedOff(): Promise<void> {
    const kinds: ('password' | 'passphrase')[] = ['password', 'passphrase'];

    await Promise.all(
      kinds.map(async kind => {
        if (this._managerFor(kind) !== false) {
          return;
        }

        const key = kind === 'password' ? this.passwordKey : this.passphraseKey;

        try {
          if ((await this._deps.store.get(key)) === undefined) {
            return;
          }
        } catch (error) {
          logger.warn(`Can't read a stored secret: ${error.message}`);
          return;
        }

        await this._forget(key, `${kind}Manager is off`);
      })
    );
  }
}

export function createCredentialResolver(
  source: CredentialSource
): CredentialResolver {
  return new CredentialResolver(source, deps);
}

export function getSecretStore(): SecretStore {
  return deps.store;
}
