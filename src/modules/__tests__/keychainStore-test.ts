import {
  createKeychainStore,
  parsePassword,
  SecurityResult,
  SecurityRunner,
  parseAccounts,
} from '../keychainStore';

const ITEM_NOT_FOUND = 44;
const SEP = '|';

interface Call {
  args: string[];
  stdin?: string;
}

function result(
  code: number,
  stdout: string,
  stderr = ''
): Promise<SecurityResult> {
  return Promise.resolve({ code, stdout, stderr });
}

/**
 * The tokenizer `security -i` applies: values are double quoted, with \" and
 * \\ escapes inside. Checked against the real binary.
 */
function defaultParse(line: string): string[] {
  const values: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  let match = pattern.exec(line);
  while (match) {
    values.push(match[1].replace(/\\(.)/g, '$1'));
    match = pattern.exec(line);
  }
  return values;
}

/**
 * Stands in for /usr/bin/security, keeping a map of items so a write followed
 * by the store's own read-back behaves like the real thing.
 */
function createSecurity(option: { parse?: (line: string) => string[] } = {}) {
  const items = new Map<string, string>();
  const calls: Call[] = [];
  const parse = option.parse || defaultParse;

  const run: SecurityRunner = (args, stdin) => {
    calls.push({ args, stdin });

    if (args[0] === 'find-generic-password') {
      // find-generic-password -g -s <service> -a <account>
      const key = args[3] + SEP + args[5];
      if (!items.has(key)) {
        return result(ITEM_NOT_FOUND, '', 'could not be found');
      }
      // The password line goes to stderr, the attributes to stdout.
      return result(0, 'keychain: "test"\n', formatPassword(items.get(key)!) + '\n');
    }

    if (args[0] === 'delete-generic-password') {
      const key = args[2] + SEP + args[4];
      if (!items.delete(key)) {
        return result(ITEM_NOT_FOUND, '', 'could not be found');
      }
      return result(0, '');
    }

    if (args[0] === '-i') {
      const fields = parse(stdin!);
      items.set(fields[0] + SEP + fields[1], fields[3]);
      return result(0, '');
    }

    return result(1, '', 'unexpected: ' + args.join(' '));
  };

  return { run, calls, items };
}

/**
 * How `security -g` renders a password: verbatim when it is printable ASCII,
 * and as `0x<HEX>  "<escaped>"` otherwise. Checked against the real binary.
 */
function formatPassword(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) {
    return `password: "${value}"`;
  }

  const hex = Buffer.from(value, 'utf8')
    .toString('hex')
    .toUpperCase();
  return `password: 0x${hex}  "escaped-form"`;
}

const PASSWORD_KEY = 'password:sftp://deploy@example.com:22';

describe('keychain store', () => {
  it('files a password where Keychain Access will show it', async () => {
    const security = createSecurity();
    const store = createKeychainStore(security.run);

    await store.set(PASSWORD_KEY, 'hunter2');

    const write = security.calls.find(c => c.args[0] === '-i')!;
    expect(write.stdin).toContain('"vscode-sftp"');
    expect(write.stdin).toContain('"sftp://deploy@example.com:22"');
    // The Name column reads as an account, not as the Account column repeated.
    expect(write.stdin).toContain('"deploy@example.com"');
    // The secret goes over stdin, never in the arguments, where `ps` sees it.
    expect(write.args).toEqual(['-i']);
    expect(security.calls.every(c => !c.args.includes('hunter2'))).toBe(true);
  });

  it('keeps key passphrases under their own name', async () => {
    const security = createSecurity();
    const store = createKeychainStore(security.run);

    await store.set('passphrase:/home/me/.ssh/id_ed25519', 'secret');

    const write = security.calls.find(c => c.args[0] === '-i')!;
    expect(write.stdin).toContain('"vscode-sftp-passphrase"');
    expect(write.stdin).toContain('"/home/me/.ssh/id_ed25519"');
  });

  it('round-trips passwords the line parser could mangle', async () => {
    const security = createSecurity();
    const store = createKeychainStore(security.run);

    const awkward = [
      'has space',
      'has"quote',
      'has\'quote',
      'has\\back',
      'has$dollar',
      'trailing ',
      'a "quoted phrase" and a \\ backslash',
      'deadbeef',
      'tab\there',
      'unicode-passwörd',
      'emoji \u{1F511} key',
    ];

    for (const password of awkward) {
      await store.set(PASSWORD_KEY, password);
      expect(await store.get(PASSWORD_KEY)).toBe(password);
    }
  });

  it('refuses a password it cannot write down in one line', async () => {
    const security = createSecurity();
    const store = createKeychainStore(security.run);

    await expect(store.set(PASSWORD_KEY, 'two\nlines')).rejects.toThrow(
      /line break/
    );
    expect(security.calls).toEqual([]);
  });

  it('removes the item and complains when it reads back changed', async () => {
    // A parser that drops everything after the first space, which is what an
    // unquoted value does to the real binary.
    const security = createSecurity({
      parse: line => defaultParse(line).map(v => v.split(' ')[0]),
    });
    const store = createKeychainStore(security.run);

    await expect(store.set(PASSWORD_KEY, 'has space')).rejects.toThrow(
      /did not store the secret unchanged/
    );

    expect(security.items.size).toBe(0);
  });

  it('reports a missing item as missing, not as an error', async () => {
    const security = createSecurity();
    const store = createKeychainStore(security.run);

    expect(await store.get('password:sftp://nobody@example.com:22')).toBeUndefined();
    await store.delete('password:sftp://nobody@example.com:22');
  });

  it('reads a password back through the arguments it was stored under', async () => {
    const security = createSecurity();
    const store = createKeychainStore(security.run);

    await store.set(PASSWORD_KEY, 'hunter2');
    const read = security.calls.find(
      c => c.args[0] === 'find-generic-password'
    )!;

    // -g rather than -w: -w renders anything non-ASCII as bare hex, which is
    // indistinguishable from a password that looks like hex.
    expect(read.args).toContain('-g');
    expect(read.args).not.toContain('-w');
  });

  it('passes on a real failure rather than hiding it', async () => {
    const run: SecurityRunner = () =>
      result(36, '', 'The user name or passphrase you entered is not correct.');
    const store = createKeychainStore(run);

    await expect(store.get(PASSWORD_KEY)).rejects.toThrow(
      /security failed \(36\)/
    );
  });

  it('updates in place instead of failing as a duplicate', async () => {
    const security = createSecurity();
    const store = createKeychainStore(security.run);

    await store.set(PASSWORD_KEY, 'first');
    await store.set(PASSWORD_KEY, 'second');

    expect(await store.get(PASSWORD_KEY)).toBe('second');
    security.calls
      .filter(c => c.args[0] === '-i')
      .forEach(c => expect(c.stdin).toContain('-U'));
  });
});

describe('parsePassword', () => {
  it('takes a plain password verbatim', () => {
    expect(parsePassword('password: "hunter2"')).toBe('hunter2');
  });

  it('does not mistake a hex-looking password for hex', () => {
    expect(parsePassword('password: "deadbeef"')).toBe('deadbeef');
  });

  it('decodes the hex form', () => {
    expect(parsePassword('password: 0x7461620968657265  "tab\\011here"')).toBe(
      'tab\there'
    );
  });

  it('decodes hex as utf-8, not byte by byte', () => {
    const hex = Buffer.from('passwörd', 'utf8')
      .toString('hex')
      .toUpperCase();
    expect(parsePassword(`password: 0x${hex}  "escaped"`)).toBe('passwörd');
  });

  it('keeps quotes that are inside the password', () => {
    // security does not escape these, so the outermost pair delimits.
    expect(parsePassword('password: "has"quote"')).toBe('has"quote');
  });

  it('finds the line among the attributes around it', () => {
    const output = [
      'keychain: "/Users/me/Library/Keychains/login.keychain-db"',
      'class: "genp"',
      'attributes:',
      '    "acct"<blob>="deploy@example.com:22"',
      'password: "hunter2"',
    ].join('\n');
    expect(parsePassword(output)).toBe('hunter2');
  });

  it('says nothing rather than guessing when there is no password line', () => {
    expect(parsePassword('class: "genp"')).toBeUndefined();
  });
});

/**
 * The keychain can say which keys it holds, and that matters: the alternative
 * was a list kept by the extension, and such a list starts empty - every
 * password stored before it existed would be invisible, which is exactly why
 * following a rename did nothing on a machine that already had its passwords.
 */
describe('reading which accounts the keychain holds', () => {
  const dump = [
    'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
    'version: 512',
    'class: "genp"',
    'attributes:',
    '    0x00000007 <blob>="dr@example.com (one.com)"',
    '    "acct"<blob>="sftp://dr@example.com:22/one.com"',
    '    "desc"<blob>=<NULL>',
    '    "svce"<blob>="vscode-sftp"',
    'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
    'attributes:',
    '    "acct"<blob>="sftp://dr@example.com:22/two.com"',
    '    "svce"<blob>="vscode-sftp"',
    'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
    'attributes:',
    '    "acct"<blob>="somebody@else"',
    '    "svce"<blob>="Chrome Safe Storage"',
  ].join('\n');

  it('finds the accounts filed under one service', () => {
    expect(parseAccounts(dump, 'vscode-sftp')).toEqual([
      'sftp://dr@example.com:22/one.com',
      'sftp://dr@example.com:22/two.com',
    ]);
  });

  it('leaves other services alone', () => {
    expect(parseAccounts(dump, 'vscode-sftp')).not.toContain('somebody@else');
    expect(parseAccounts(dump, 'Chrome Safe Storage')).toEqual(['somebody@else']);
  });

  it('does not carry an account across a block boundary', () => {
    // A block whose service is not ours must not lend its account to the next.
    const odd = [
      'keychain: "x"',
      '    "acct"<blob>="sftp://dr@example.com:22/orphan"',
      'keychain: "x"',
      '    "svce"<blob>="vscode-sftp"',
    ].join('\n');

    expect(parseAccounts(odd, 'vscode-sftp')).toEqual([]);
  });

  it('says nothing about an empty dump', () => {
    expect(parseAccounts('', 'vscode-sftp')).toEqual([]);
  });

  function dated(account: string, mdat: string, cdat = mdat) {
    return [
      'keychain: "x"',
      'attributes:',
      `    "acct"<blob>="${account}"`,
      `    "cdat"<timedate>=0x00  "${cdat}Z\\000"`,
      `    "mdat"<timedate>=0x00  "${mdat}Z\\000"`,
      '    "svce"<blob>="vscode-sftp"',
    ].join('\n');
  }

  it('puts the most recently changed one first', () => {
    // Which is what settles it when several records could answer for one
    // login: the newest is the likeliest to still be the password.
    const dump = [
      dated('older', '20260101120000'),
      dated('newest', '20260921003036'),
      dated('middling', '20260615080000'),
    ].join('\n');

    expect(parseAccounts(dump, 'vscode-sftp')).toEqual([
      'newest',
      'middling',
      'older',
    ]);
  });

  it('goes by when a record was changed, not when it was written', () => {
    // A password that was corrected last week is the current one, whatever
    // date the record was first created on.
    const dump = [
      dated('written-later', '20260101120000', '20260901120000'),
      dated('corrected', '20260801120000', '20260101120000'),
    ].join('\n');

    expect(parseAccounts(dump, 'vscode-sftp')[0]).toBe('corrected');
  });

  it('keeps the order the keychain gave where the dates are the same', () => {
    const dump = [
      dated('first', '20260101120000'),
      dated('second', '20260101120000'),
    ].join('\n');

    expect(parseAccounts(dump, 'vscode-sftp')).toEqual(['first', 'second']);
  });

  it('puts a record with no date it can read last', () => {
    // Nothing to go on is not a reason to prefer it.
    const dump = [
      'keychain: "x"',
      '    "acct"<blob>="undated"',
      '    "svce"<blob>="vscode-sftp"',
      dated('dated', '20260101120000'),
    ].join('\n');

    expect(parseAccounts(dump, 'vscode-sftp')).toEqual(['dated', 'undated']);
  });
});
