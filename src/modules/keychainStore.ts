import { execFile } from 'child_process';
import {
  KEYCHAIN_SERVICE_PASSPHRASE,
  KEYCHAIN_SERVICE_PASSWORD,
  KeychainItem,
  SecretStore,
  toKeychainItem,
} from '../core/credentialResolver';
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

/**
 * The keys this keychain holds for us, from `dump-keychain`.
 *
 * Attributes only - no `-d`, so no secret is read and nothing prompts. Blocks
 * start at `keychain:` and print `acct` before `svce`, so the account of the
 * block being described is the last one seen when the service matches.
 *
 * Worth having because the alternative was a list we kept ourselves, and such
 * a list starts empty: every password stored before it existed, or written by
 * the sweep straight into the store, would be invisible to it. The keychain
 * already knows.
 *
 * Newest change first, because the dates are here too: `cdat` and `mdat` are
 * plain attributes, so where several records could answer for one login, the
 * most recently written one can be preferred without reading any of them.
 */
export function parseAccounts(output: string, service: string): string[] {
  const found: Array<{ account: string; changed: string }> = [];
  let account: string | undefined;
  let changed = '';

  output.split('\n').forEach(line => {
    if (line.indexOf('keychain:') === 0) {
      account = undefined;
      changed = '';
      return;
    }

    const acct = line.match(/^\s*"acct"<blob>="(.*)"$/);
    if (acct) {
      account = acct[1];
      return;
    }

    // `"mdat"<timedate>=0x...  "20260921003036Z\000"`, and `cdat` in the same
    // shape for an item never changed since it was written. The quoted half is
    // the readable one and sorts as a string, being fixed-width UTC.
    const date = line.match(/^\s*"(mdat|cdat)"<timedate>=.*"(\d{14})Z/);
    if (date) {
      // `mdat` wins: both are present, and the question is when this record
      // last said something, not when it first did.
      if (date[1] === 'mdat' || !changed) {
        changed = date[2];
      }
      return;
    }

    const svce = line.match(/^\s*"svce"<blob>="(.*)"$/);
    if (svce && svce[1] === service && account !== undefined) {
      found.push({ account, changed });
      account = undefined;
      changed = '';
    }
  });

  // Newest first, which is what decides between several records for one login:
  // the one most recently written is the one most likely to still be the
  // password. Equal dates keep the order the keychain gave them.
  return found
    .map((one, at) => ({ ...one, at }))
    .sort((a, b) =>
      a.changed === b.changed
        ? a.at - b.at
        : (b.changed || '').localeCompare(a.changed || '')
    )
    .map(one => one.account);
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

  /**
   * The last dump, so a window full of connections costs one.
   *
   * Reading the whole keychain takes a quarter of a second, and it is read when
   * a connection finds nothing under its own key - which, the first time a
   * config is opened, can be every connection in it. Held until something is
   * written or removed, because that is the only thing here that can make it
   * wrong.
   */
  let dumped: Promise<string> | undefined;

  function dump(): Promise<string> {
    if (!dumped) {
      dumped = run(['dump-keychain']).then(result =>
        result.code === 0 ? result.stdout : ''
      );
    }

    return dumped;
  }

  function forgetTheDump(): void {
    dumped = undefined;
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

      forgetTheDump();
      logger.info(`Saved "${item.label}" to the Keychain.`);
    },

    async delete(key) {
      await remove(toKeychainItem(key));
      forgetTheDump();
    },

    async list() {
      // One dump, parsed twice: the two services are in the same output, and
      // asking for it twice would pay for reading the keychain twice.
      const output = await dump();
      const passwords = parseAccounts(output, KEYCHAIN_SERVICE_PASSWORD);
      const passphrases = parseAccounts(output, KEYCHAIN_SERVICE_PASSPHRASE);

      return passwords
        .map(one => `password:${one}`)
        .concat(passphrases.map(one => `passphrase:${one}`));
    },
  };
}
