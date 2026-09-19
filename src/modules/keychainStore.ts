import { execFile } from 'child_process';
import { KeychainItem, SecretStore, toKeychainItem } from '../core/credentialResolver';
import logger from '../logger';

const SECURITY = '/usr/bin/security';
const TIMEOUT = 15 * 1000;

/** errSecItemNotFound: the item simply isn't there, which is not a failure. */
const ITEM_NOT_FOUND = 44;

export interface SecurityResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SecurityRunner = (
  args: string[],
  stdin?: string
) => Promise<SecurityResult>;

/**
 * `security -i` reads commands from stdin, which is the only way to set a
 * password without putting it in argv where `ps` can read it. It splits that
 * line itself, so every value has to be quoted: an unquoted space silently
 * stores nothing at all.
 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Reads the password out of `find-generic-password -g`.
 *
 * `-w` is not usable here: it prints a password containing anything outside
 * printable ASCII as bare hex, which is indistinguishable from a password
 * that happens to look like hex. `-g` prints `password: 0x<HEX>  "..."` in
 * that case and `password: "..."` otherwise, so the `0x` marker settles it.
 */
export function parsePassword(output: string): string | undefined {
  const line = output
    .split('\n')
    .find(candidate => candidate.startsWith('password: '));

  if (line === undefined) {
    return undefined;
  }

  const value = line.slice('password: '.length);

  if (value.startsWith('0x')) {
    const hex = value.slice(2).split(/\s/)[0];
    return Buffer.from(hex, 'hex').toString('utf8');
  }

  // `password: "<raw>"`, where raw is printed verbatim - an embedded quote is
  // not escaped, so take everything between the outermost pair.
  const first = value.indexOf('"');
  const last = value.lastIndexOf('"');
  if (first === -1 || last <= first) {
    return undefined;
  }

  return value.slice(first + 1, last);
}

function runSecurity(args: string[], stdin?: string): Promise<SecurityResult> {
  return new Promise(resolve => {
    const child = execFile(
      SECURITY,
      args,
      { timeout: TIMEOUT },
      (error: any, stdout, stderr) => {
        resolve({
          // execFile reports a non-zero exit through `error.code`.
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: stdout ? stdout.toString() : '',
          stderr: stderr ? stderr.toString() : '',
        });
      }
    );

    if (stdin !== undefined && child.stdin) {
      child.stdin.end(stdin);
    }
  });
}

/**
 * Secrets as ordinary Keychain items, one per server, visible and editable in
 * Keychain Access and readable by anything else on the machine that asks.
 */
export function createKeychainStore(
  run: SecurityRunner = runSecurity
): SecretStore {
  async function read(item: KeychainItem): Promise<string | undefined> {
    const result = await run([
      'find-generic-password',
      '-g',
      '-s',
      item.service,
      '-a',
      item.account,
    ]);

    if (result.code === ITEM_NOT_FOUND) {
      return undefined;
    }

    if (result.code !== 0) {
      throw new Error(
        `security failed (${result.code}): ${result.stderr.trim() ||
          'no detail'}`
      );
    }

    // `-g` writes the password line to stderr and the attributes to stdout.
    const password = parsePassword(result.stderr + result.stdout);
    if (password === undefined) {
      throw new Error('Could not read the password out of the Keychain.');
    }

    return password;
  }

  async function remove(item: KeychainItem): Promise<void> {
    const result = await run([
      'delete-generic-password',
      '-s',
      item.service,
      '-a',
      item.account,
    ]);

    if (result.code !== 0 && result.code !== ITEM_NOT_FOUND) {
      throw new Error(
        `security failed (${result.code}): ${result.stderr.trim() ||
          'no detail'}`
      );
    }
  }

  return {
    get(key) {
      return read(toKeychainItem(key));
    },

    async set(key, value) {
      const item = toKeychainItem(key);

      // The command is one line, so a secret containing one can't be written
      // this way. Better to say so than to store half of it.
      if (/[\r\n]/.test(value)) {
        throw new Error(
          'The Keychain store cannot hold a password containing a line break.'
        );
      }

      // -U updates in place; without it a second save fails as a duplicate.
      const command = [
        'add-generic-password',
        '-U',
        '-s',
        quote(item.service),
        '-a',
        quote(item.account),
        '-l',
        quote(item.label),
        '-w',
        quote(value),
      ].join(' ');

      const result = await run(['-i'], `${command}\n`);
      if (result.code !== 0) {
        throw new Error(
          `security failed (${result.code}): ${result.stderr.trim() ||
            'no detail'}`
        );
      }

      // `security -i` does its own quoting, and getting it wrong stores a
      // truncated secret rather than failing. Read it back before believing it.
      const stored = await read(item);
      if (stored !== value) {
        await remove(item).catch(() => undefined);
        throw new Error(
          'The Keychain did not store the secret unchanged, so it was removed again.'
        );
      }

      logger.info(`Saved "${item.label}" to the Keychain.`);
    },

    delete(key) {
      return remove(toKeychainItem(key));
    },
  };
}
