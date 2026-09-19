import {
  createKeychainStore,
  parsePassword,
  SecurityResult,
  SecurityRunner,
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
    expect(write.stdin).toContain('"SFTP: sftp://deploy@example.com:22"');
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
