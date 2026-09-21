import {
  CredentialSource,
  passwordKeyFor,
  passphraseKeyFor,
} from './credentialResolver';

/**
 * Every plain-text secret in an `sftp.json`, and where each one belongs.
 *
 * Migration already existed but only ever one connection at a time, only when
 * that connection was next used, and only if somebody had already written
 * `passwordManager` into it by hand. With twenty-eight files and a hundred and
 * fifty-six connections that is not a migration path, it is a chore nobody
 * finishes - and every password not moved is a password sitting in a file that
 * gets committed by accident one day.
 *
 * So: read the file as it is written rather than as it resolves. A connection
 * is any object with a host and a string password; a profile is one of those
 * too, inheriting whatever it does not say for itself, because `passwordKeyFor`
 * needs the host and user a profile may only have got from its parent.
 */

export interface FoundSecret {
  /** `password` or `passphrase`. */
  kind: 'password' | 'passphrase';
  /** The literal, as written in the file. */
  value: string;
  /** Where it will live once moved. */
  key: string;
  /** What to call this connection when asking about it. */
  label: string;
  /**
   * Another secret already claims this key, with a different value.
   *
   * A profile that overrides only the password inherits its parent's host,
   * user and port - and those are the whole of the key - so the two cannot
   * both be stored. Moving one and blanking both by value would destroy the
   * other, so neither is moved and the caller says so.
   */
  conflict?: boolean;
}

function portFor(config: any): number {
  if (typeof config.port === 'number') {
    return config.port;
  }

  return config.protocol === 'ftp' ? 21 : 22;
}

function sourceOf(config: any): CredentialSource {
  return {
    protocol: config.protocol || 'sftp',
    host: config.host,
    port: portFor(config),
    username: config.username,
    privateKeyPath: config.privateKeyPath,
    // The whole of what makes a record per project rather than per account.
    name: typeof config.name === 'string' ? config.name : undefined,
  } as CredentialSource;
}

function nameOf(config: any, source: CredentialSource): string {
  if (typeof config.name === 'string' && config.name !== '') {
    return config.name;
  }

  return source.username ? `${source.username}@${source.host}` : source.host;
}

/**
 * Every connection object in a parsed config, with profiles merged over their
 * parent.
 *
 * A profile that names only a password still belongs to its parent's host, and
 * a key built from a profile alone would be `sftp://undefined@undefined:22`.
 */
export function connectionsIn(config: any): any[] {
  const found: any[] = [];

  const visit = (node: any, inherited: any): void => {
    if (Array.isArray(node)) {
      node.forEach(one => visit(one, inherited));
      return;
    }

    if (!node || typeof node !== 'object') {
      return;
    }

    const merged = { ...inherited, ...node };
    if (merged.host) {
      found.push(merged);
    }

    const profiles = node.profiles;
    if (profiles && typeof profiles === 'object') {
      Object.keys(profiles).forEach(name => {
        const profile = profiles[name];
        if (profile && typeof profile === 'object') {
          visit({ ...profile, name: profile.name || `${merged.name || merged.host} (${name})` }, merged);
        }
      });
    }
  };

  visit(config, {});

  return found;
}

/**
 * A connection whose secret lives in a store rather than in the file.
 *
 * `password: true` means "not here"; which store it is in is whatever the
 * connection names, or the `sftp.passwordManager` setting when it names
 * nothing. Both are reported, because moving it out means reading it from the
 * right place first.
 */
export interface StoredSecret {
  kind: 'password' | 'passphrase';
  key: string;
  label: string;
  /** What the connection itself says, if anything. */
  manager?: string | boolean;
}

export function storedIn(config: any): StoredSecret[] {
  const found: StoredSecret[] = [];
  const seen = new Set<string>();

  for (const connection of connectionsIn(config)) {
    const source = sourceOf(connection);
    const label = nameOf(connection, source);

    const take = (kind: 'password' | 'passphrase', key: string) => {
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      found.push({
        kind,
        key,
        label,
        manager:
          kind === 'password'
            ? connection.passwordManager
            : connection.passphraseManager,
      });
    };

    if (connection.password === true) {
      take('password', passwordKeyFor(source));
    }
    if (connection.passphrase === true) {
      take('passphrase', passphraseKeyFor(source));
    }
  }

  return found;
}

/**
 * The file with secrets written back into it as plain text.
 *
 * The other direction, for somebody who wants them in the file again - and it
 * has to be by connection rather than by value, because a `true` says nothing
 * about which secret it stands for.
 */
export function withSecretsWritten(
  config: any,
  values: { [key: string]: string }
): any {
  const visit = (node: any, inherited: any): void => {
    if (Array.isArray(node)) {
      node.forEach(one => visit(one, inherited));
      return;
    }

    if (!node || typeof node !== 'object') {
      return;
    }

    const merged = { ...inherited, ...node };

    if (merged.host) {
      const source = sourceOf(merged);

      if (node.password === true) {
        const value = values[passwordKeyFor(source)];
        if (value !== undefined) {
          node.password = value;
        }
      }
      if (node.passphrase === true) {
        const value = values[passphraseKeyFor(source)];
        if (value !== undefined) {
          node.passphrase = value;
        }
      }
    }

    const profiles = node.profiles;
    if (profiles && typeof profiles === 'object') {
      Object.keys(profiles).forEach(name => visit(profiles[name], merged));
    }
  };

  visit(config, {});

  return config;
}

/**
 * The file with every per-connection `passwordManager` taken out.
 *
 * A connection that names its own store overrides the setting, so leaving one
 * behind after moving everything somewhere else means that connection alone
 * still looks in the old place - and nothing on screen would say why.
 */
export function withManagersRemoved(config: any): any {
  const visit = (node: any): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    if (!node || typeof node !== 'object') {
      return;
    }

    delete node.passwordManager;
    delete node.passphraseManager;

    Object.keys(node).forEach(key => visit(node[key]));
  };

  visit(config);

  return config;
}

/** What one file is carrying in plain text. */
export function secretsIn(config: any): FoundSecret[] {
  const found: FoundSecret[] = [];
  const claimed = new Map<string, string>();

  const take = (
    kind: 'password' | 'passphrase',
    value: string,
    key: string,
    label: string
  ): void => {
    const already = claimed.get(key);

    if (already === value) {
      return; // The same secret written twice is one secret.
    }

    // Two secrets under one key. With a record per project this is rare -
    // it needs two connections of the same name on the same account - but a
    // store still cannot hold both, so neither is moved.
    if (already !== undefined) {
      found.push({ kind, value, key, label, conflict: true });
      return;
    }

    claimed.set(key, value);
    found.push({ kind, value, key, label });
  };

  for (const connection of connectionsIn(config)) {
    const source = sourceOf(connection);
    const label = nameOf(connection, source);

    if (typeof connection.password === 'string' && connection.password !== '') {
      take('password', connection.password, passwordKeyFor(source), label);
    }

    if (typeof connection.passphrase === 'string' && connection.passphrase !== '') {
      take('passphrase', connection.passphrase, passphraseKeyFor(source), label);
    }
  }

  return found;
}

/**
 * The file with every moved secret replaced by `true`.
 *
 * Only values equal to ones actually stored are touched - the same rule the
 * single-connection migration follows - so a password that could not be saved
 * stays exactly where it was. Losing the only copy of a password is a worse
 * outcome than leaving it in plain text a little longer.
 */
export function withSecretsRemoved(config: any, moved: FoundSecret[]): any {
  const passwords = new Set(
    moved.filter(one => one.kind === 'password').map(one => one.value)
  );
  const passphrases = new Set(
    moved.filter(one => one.kind === 'passphrase').map(one => one.value)
  );

  const visit = (node: any): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    if (!node || typeof node !== 'object') {
      return;
    }

    if (typeof node.password === 'string' && passwords.has(node.password)) {
      node.password = true;
    }
    if (typeof node.passphrase === 'string' && passphrases.has(node.passphrase)) {
      node.passphrase = true;
    }

    Object.keys(node).forEach(key => visit(node[key]));
  };

  visit(config);

  return config;
}


/**
 * The file with one account's written-in passwords changed.
 *
 * Only the ones written in the file: a connection whose password is `true`
 * keeps its `true`, because the new value belongs in the store it points at.
 */
export function withPasswordChanged(
  config: any,
  keys: string[],
  value: string
): any {
  const wanted = new Set(keys);

  const visit = (node: any, inherited: any): void => {
    if (Array.isArray(node)) {
      node.forEach(one => visit(one, inherited));
      return;
    }

    if (!node || typeof node !== 'object') {
      return;
    }

    const merged = { ...inherited, ...node };

    if (
      merged.host &&
      typeof node.password === 'string' &&
      wanted.has(passwordKeyFor(sourceOf(merged)))
    ) {
      node.password = value;
    }

    const profiles = node.profiles;
    if (profiles && typeof profiles === 'object') {
      Object.keys(profiles).forEach(name =>
        visit(
          { ...profiles[name], name: profiles[name].name || `${merged.name || merged.host} (${name})` },
          merged
        )
      );
    }
  };

  visit(config, {});

  return config;
}

/** `sftp://dr@host:2121`, the part several projects share. */
export function accountOf(key: string): string {
  const id = key.slice(key.indexOf(':') + 1);
  const slash = id.indexOf('/', id.indexOf('://') + 3);

  return slash === -1 ? id : id.slice(0, slash);
}
