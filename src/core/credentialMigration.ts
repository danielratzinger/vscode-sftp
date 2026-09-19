import * as fse from 'fs-extra';
import logger from '../logger';
import {
  CredentialResolver,
  CredentialSource,
  passphraseKeyFor,
  passwordKeyFor,
} from './credentialResolver';

export interface LiteralSecrets {
  password?: string;
  passphrase?: string;
}

/**
 * Indentation of the file as written, so rewriting it doesn't reformat
 * everything around the one value that changed.
 */
export function detectIndent(text: string): number | string {
  const match = text.match(/\n([ \t]+)\S/);
  if (!match) {
    return 4;
  }

  return match[1][0] === '\t' ? '\t' : match[1].length;
}

/**
 * Replaces the secrets that were moved into the store with `true`.
 *
 * Every object in the file is visited, so a password inside `profiles` or a
 * config listed in an array is handled too. Only values equal to the ones
 * actually stored are touched, which is what keeps an unrelated server's
 * password from being cleared along the way.
 */
export function rewriteConfig(text: string, stored: LiteralSecrets): string {
  const config = JSON.parse(text);

  const visit = (node: any): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    if (!node || typeof node !== 'object') {
      return;
    }

    if (stored.password !== undefined && node.password === stored.password) {
      node.password = true;
    }
    if (stored.passphrase !== undefined && node.passphrase === stored.passphrase) {
      node.passphrase = true;
    }
    Object.keys(node).forEach(key => visit(node[key]));
  };

  visit(config);

  return JSON.stringify(config, null, detectIndent(text)) + '\n';
}

/** What a config is carrying in plain text that could live in the store instead. */
export function literalSecretsOf(config: any): LiteralSecrets {
  const secrets: LiteralSecrets = {};

  if (typeof config.password === 'string' && config.password !== '') {
    secrets.password = config.password;
  }
  if (typeof config.passphrase === 'string' && config.passphrase !== '') {
    secrets.passphrase = config.passphrase;
  }

  return secrets;
}

/**
 * Moves a password written into sftp.json to the credential store, and takes
 * it out of the file.
 *
 * Runs only after a connection has succeeded, so a password that doesn't work
 * is never the one that gets saved, and the file is rewritten only once the
 * store has been read back and agrees. Anything less certain leaves the file
 * exactly as it was: losing the only copy of a password would be a far worse
 * outcome than leaving it in plain text a little longer.
 */
/**
 * Whether this config has a password written into it that a named manager
 * could hold instead.
 */
export function needsMigration(config: any): boolean {
  const literals = literalSecretsOf(config);

  return (
    (literals.password !== undefined && config.passwordManager !== undefined) ||
    (literals.passphrase !== undefined && config.passphraseManager !== undefined)
  );
}

export async function migrateLiteralSecrets(
  config: CredentialSource,
  configPath: string,
  resolver: CredentialResolver
): Promise<boolean> {
  const all = literalSecretsOf(config);

  // Named on the connection itself, and writable. The `sftp.passwordManager`
  // setting deliberately doesn't count: rewriting someone's config file is
  // not something a machine-wide default should start doing on its own.
  const secrets: LiteralSecrets = {};
  if (
    all.password !== undefined &&
    config.passwordManager !== undefined &&
    resolver.storeForKind('password')
  ) {
    secrets.password = all.password;
  }
  if (
    all.passphrase !== undefined &&
    config.passphraseManager !== undefined &&
    resolver.storeForKind('passphrase')
  ) {
    secrets.passphrase = all.passphrase;
  }

  if (Object.keys(secrets).length === 0) {
    return false;
  }

  const keys: LiteralSecrets = {
    password: secrets.password === undefined ? undefined : passwordKeyFor(config),
    passphrase:
      secrets.passphrase === undefined ? undefined : passphraseKeyFor(config),
  };

  try {
    for (const kind of ['password', 'passphrase'] as const) {
      const value = secrets[kind];
      const key = keys[kind];
      const store = resolver.storeForKind(kind);
      if (value === undefined || key === undefined || !store) {
        continue;
      }

      await store.set(key, value);

      const readBack = await store.get(key);
      if (readBack !== value) {
        throw new Error(
          `the ${kind} did not come back out of the store unchanged`
        );
      }
    }
  } catch (error) {
    logger.error(
      `Leaving ${configPath} alone: could not save the credentials (${error.message}).`
    );
    return false;
  }

  try {
    const text = await fse.readFile(configPath, 'utf8');
    await fse.writeFile(configPath, rewriteConfig(text, secrets), 'utf8');
  } catch (error) {
    logger.error(
      `Saved the credentials, but could not rewrite ${configPath} (${error.message}). ` +
        'The password is still in the file; remove it by hand and set "password": true.'
    );
    return false;
  }

  logger.info(
    `Moved the ${Object.keys(secrets).join(' and ')} for ${config.host} ` +
      `into the credential store, and out of ${configPath}.`
  );

  return true;
}
