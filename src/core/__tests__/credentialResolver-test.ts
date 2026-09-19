import {
  CredentialResolver,
  isAuthFailure,
  SecretStore,
} from '../credentialResolver';

function createStore(initial: { [key: string]: string } = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  const store: SecretStore & { values: Map<string, string> } = {
    values,
    get: key => Promise.resolve(values.get(key)),
    set: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: key => {
      values.delete(key);
      return Promise.resolve();
    },
  };
  return store;
}

const SOURCE = {
  protocol: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'deploy',
};

const PASSWORD_KEY = 'password:sftp://deploy@example.com:22';

function createResolver(source: any, store: any, answers: (string | undefined)[] = []) {
  const prompts: string[] = [];
  const commands: string[] = [];
  const programs: string[][] = [];

  const resolver = new CredentialResolver(
    { ...SOURCE, ...source },
    {
      store,
      prompt: message => {
        prompts.push(message);
        return Promise.resolve(answers.shift());
      },
      runCommand: command => {
        commands.push(command);
        return Promise.resolve('from-command');
      },
      runProgram: argv => {
        programs.push(argv);
        return Promise.resolve('from-provider\nsecond line');
      },
      // Only the built-in store is writable in these tests; a named manager
      // is read-only, which is what sends it down the manager path.
      storeFor: manager => (manager === true ? store : undefined),
      defaultManager: () => true,
    }
  );

  return { resolver, prompts, commands, programs };
}

describe('CredentialResolver', () => {
  it('passes a literal password straight through', async () => {
    const store = createStore();
    const { resolver, prompts } = createResolver({ password: 'literal' }, store);

    expect(await resolver.resolve()).toEqual({ password: 'literal' });
    expect(prompts).toEqual([]);
  });

  it('reads a remembered password instead of asking', async () => {
    const store = createStore({ [PASSWORD_KEY]: 'remembered' });
    const { resolver, prompts } = createResolver({ password: true }, store);

    expect(await resolver.resolve()).toEqual({ password: 'remembered' });
    expect(prompts).toEqual([]);
  });

  it('leaves the password unresolved when nothing is stored yet', async () => {
    const store = createStore();
    const { resolver } = createResolver({ password: true }, store);

    expect(await resolver.resolve()).toEqual({});
  });

  it('takes the output of a credential command', async () => {
    const store = createStore();
    const { resolver, commands } = createResolver(
      { passwordCommand: 'security find-generic-password -w -s x' },
      store
    );

    expect(await resolver.resolve()).toEqual({ password: 'from-command' });
    expect(commands).toEqual(['security find-generic-password -w -s x']);
    expect(store.values.size).toBe(0);
  });

  it('prefers the command over anything stored', async () => {
    const store = createStore({ [PASSWORD_KEY]: 'remembered' });
    const { resolver } = createResolver(
      { password: true, passwordCommand: 'op read x' },
      store
    );

    expect(await resolver.resolve()).toEqual({ password: 'from-command' });
  });

  it('remembers what was typed, but only once the connection worked', async () => {
    const store = createStore();
    const { resolver } = createResolver({ password: true }, store, ['typed']);

    await resolver.resolve();
    expect(
      await resolver.ask('Enter your password', {
        kind: 'password',
        host: 'example.com',
      })
    ).toBe('typed');

    // Nothing is written until the server has accepted it.
    expect(store.values.size).toBe(0);

    await resolver.commit();
    expect(store.values.get(PASSWORD_KEY)).toBe('typed');
  });

  it('throws away a mistyped password when the connection fails', async () => {
    const store = createStore();
    const { resolver } = createResolver({ password: true }, store, ['typo']);

    await resolver.ask('Enter your password', {
      kind: 'password',
      host: 'example.com',
    });
    await resolver.discard(new Error('All configured authentication methods failed'));
    await resolver.commit();

    expect(store.values.size).toBe(0);
  });

  it('remembers by default, with no password key in the config at all', async () => {
    const store = createStore();
    const { resolver } = createResolver({}, store, ['typed']);

    await resolver.ask('Enter your password', {
      kind: 'password',
      host: 'example.com',
    });
    await resolver.commit();

    expect(store.values.get(PASSWORD_KEY)).toBe('typed');
  });

  it('reuses that remembered password on the next connection', async () => {
    const store = createStore({ [PASSWORD_KEY]: 'remembered' });
    const { resolver, prompts } = createResolver({}, store);

    expect(await resolver.resolve()).toEqual({ password: 'remembered' });
    expect(prompts).toEqual([]);
  });

  it('asks again and deletes what it had when the manager is turned off', async () => {
    const store = createStore({
      [PASSWORD_KEY]: 'remembered',
      'passphrase:sftp://deploy@example.com:22': 'old-passphrase',
    });
    const { resolver, prompts } = createResolver(
      { password: true, passwordManager: false, passphraseManager: false },
      store,
      ['typed']
    );

    // Not used, and not left behind either.
    expect(await resolver.resolve()).toEqual({});
    expect(store.values.size).toBe(0);

    // The connection falls through to asking, and the answer isn't kept.
    expect(
      await resolver.ask('Enter your password', {
        kind: 'password',
        host: 'example.com',
      })
    ).toBe('typed');
    expect(prompts).toHaveLength(1);

    await resolver.commit();
    expect(store.values.size).toBe(0);
  });

  it('leaves other servers alone when one turns its manager off', async () => {
    const store = createStore({
      [PASSWORD_KEY]: 'mine',
      'password:sftp://deploy@other.example.com:22': 'someone else\'s',
    });
    const { resolver } = createResolver({ passwordManager: false }, store);

    await resolver.resolve();

    expect(store.values.has(PASSWORD_KEY)).toBe(false);
    expect(store.values.get('password:sftp://deploy@other.example.com:22')).toBe(
      'someone else\'s'
    );
  });

  it('still takes a credential command when the manager is off', async () => {
    const store = createStore();
    const { resolver } = createResolver(
      { passwordCommand: 'op read x', passwordManager: false },
      store
    );

    expect(await resolver.resolve()).toEqual({ password: 'from-command' });
    expect(store.values.size).toBe(0);
  });

  it('passes a vault reference through untouched', async () => {
    const store = createStore();
    const { resolver, programs } = createResolver(
      { passwordManager: '1password:op://Private/My Server/password' },
      store
    );

    await resolver.resolve();
    // Split on the first colon only: the reference has colons of its own.
    expect(programs[0]).toEqual([
      'op',
      'read',
      'op://Private/My Server/password',
    ]);
  });

  it('takes only the first line from managers that print a record', async () => {
    const store = createStore();
    const { resolver } = createResolver(
      { passwordManager: 'pass:work/ssh/server' },
      store
    );

    expect(await resolver.resolve()).toEqual({ password: 'from-provider' });
  });

  it('uses the passphrase item for a passphrase manager', async () => {
    const store = createStore();
    const { resolver, programs } = createResolver(
      {
        privateKeyPath: '/home/me/.ssh/id_ed25519',
        passphraseManager: 'secret-tool',
      },
      store
    );

    await resolver.resolve();
    expect(programs[0]).toContain('vscode-sftp-passphrase');
    expect(programs[0]).toContain('/home/me/.ssh/id_ed25519');
  });

  it('falls back to a literal until the store has one', async () => {
    const store = createStore();
    const { resolver } = createResolver(
      { password: 'from-the-file', passwordManager: true },
      store
    );

    // First connection: nothing stored yet, so the file's copy is what works.
    expect(await resolver.resolve()).toEqual({ password: 'from-the-file' });

    // Once it has been migrated, the store is what answers.
    await store.set('password:sftp://deploy@example.com:22', 'from-the-store');
    const next = createResolver(
      { password: 'from-the-file', passwordManager: true },
      store
    );
    expect(await next.resolver.resolve()).toEqual({ password: 'from-the-store' });
  });

  it('says which providers exist when the name is wrong', async () => {
    const store = createStore();
    const { resolver } = createResolver({ passwordManager: 'lastpass' }, store);

    await expect(resolver.resolve()).rejects.toThrow(/Unknown credential provider/);
  });

  it('goes looking under our own name when given only a manager', async () => {
    const store = createStore();
    const { resolver, programs } = createResolver(
      { passwordManager: '1password' },
      store
    );

    await resolver.resolve();
    // By title, not `op read`: the derived name has slashes in it, which a
    // secret reference would read as path separators.
    expect(programs[0]).toEqual([
      'op',
      'item',
      'get',
      'vscode-sftp/sftp/deploy@example.com:22',
      '--fields',
      'password',
      '--reveal',
    ]);
  });

  it('derives the same name for the path-addressed managers', async () => {
    const store = createStore();

    const viaPass = createResolver({ passwordManager: 'pass' }, store);
    await viaPass.resolver.resolve();
    expect(viaPass.programs[0]).toEqual([
      'pass',
      'show',
      'vscode-sftp/sftp/deploy@example.com:22',
    ]);

    const viaBitwarden = createResolver({ passwordManager: 'bitwarden' }, store);
    await viaBitwarden.resolver.resolve();
    expect(viaBitwarden.programs[0]).toEqual([
      'bw',
      'get',
      'password',
      'vscode-sftp/sftp/deploy@example.com:22',
    ]);
  });

  it('derives a passphrase name from the key file', async () => {
    const store = createStore();
    const { resolver, programs } = createResolver(
      {
        privateKeyPath: '/home/me/.ssh/id_ed25519',
        passphraseManager: 'pass',
      },
      store
    );

    await resolver.resolve();
    expect(programs[0]).toEqual([
      'pass',
      'show',
      'vscode-sftp-passphrase/home/me/.ssh/id_ed25519',
    ]);
  });

  it('uses the exact item when one is named', async () => {
    const store = createStore();
    const { resolver, programs } = createResolver(
      { passwordManager: 'pass:work/ssh/my-server' },
      store
    );

    await resolver.resolve();
    expect(programs[0]).toEqual(['pass', 'show', 'work/ssh/my-server']);
  });

  it('prefers an explicit command over a manager', async () => {
    const store = createStore();
    const { resolver, commands, programs } = createResolver(
      { passwordCommand: 'echo hi', passwordManager: 'keychain' },
      store
    );

    expect(await resolver.resolve()).toEqual({ password: 'from-command' });
    expect(commands).toEqual(['echo hi']);
    expect(programs).toEqual([]);
  });

  it('does not keep a hop\'s password under this host\'s name', async () => {
    const store = createStore();
    const { resolver } = createResolver({ password: true }, store, ['hop-secret']);

    await resolver.ask('Enter your password', {
      kind: 'password',
      host: 'jump.example.com',
    });
    await resolver.commit();

    expect(store.values.size).toBe(0);
  });

  it('can keep the passphrase while refusing to keep the password', async () => {
    const store = createStore();
    const { resolver } = createResolver(
      { passwordManager: false, passphraseManager: true },
      store,
      ['typed-password', 'typed-passphrase']
    );

    await resolver.ask('Enter your password', {
      kind: 'password',
      host: 'example.com',
    });
    await resolver.ask('Enter your passphrase', {
      kind: 'passphrase',
      host: 'example.com',
    });
    await resolver.commit();

    expect(store.values.has(PASSWORD_KEY)).toBe(false);
    expect(store.values.get('passphrase:sftp://deploy@example.com:22')).toBe(
      'typed-passphrase'
    );
  });

  it('never keeps a keyboard-interactive answer', async () => {
    const store = createStore();
    const { resolver } = createResolver({ password: true }, store, ['123456']);

    await resolver.ask('Verification code', {
      kind: 'interactive',
      host: 'example.com',
    });
    await resolver.commit();

    expect(store.values.size).toBe(0);
  });

  it('forgets a stored password the server rejected', async () => {
    const store = createStore({ [PASSWORD_KEY]: 'stale' });
    const { resolver } = createResolver({ password: true }, store);

    await resolver.resolve();
    await resolver.discard({ code: 530, message: 'Not logged in' });

    expect(store.values.has(PASSWORD_KEY)).toBe(false);
  });

  it('keeps a stored password when the failure was not about credentials', async () => {
    const store = createStore({ [PASSWORD_KEY]: 'good' });
    const { resolver } = createResolver({ password: true }, store);

    await resolver.resolve();
    await resolver.discard({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' });

    expect(store.values.get(PASSWORD_KEY)).toBe('good');
  });

  it('keys a passphrase by the key file, so one key is asked about once', async () => {
    const store = createStore();
    const a = createResolver(
      { host: 'a.example.com', privateKeyPath: '/home/me/.ssh/id_ed25519' },
      store
    ).resolver;
    const b = createResolver(
      { host: 'b.example.com', privateKeyPath: '/home/me/.ssh/id_ed25519' },
      store
    ).resolver;

    expect(a.passphraseKey).toBe(b.passphraseKey);
    expect(a.passwordKey).not.toBe(b.passwordKey);
  });

  it('fails loudly when a credential command produces nothing', async () => {
    const store = createStore();
    const resolver = new CredentialResolver(
      { ...SOURCE, passwordCommand: 'true' },
      {
        store,
        prompt: async () => undefined,
        runCommand: async () => '',
        runProgram: async () => '',
        storeFor: () => undefined,
        defaultManager: () => true,
      }
    );

    await expect(resolver.resolve()).rejects.toThrow(/produced no output/);
  });
});

describe('isAuthFailure', () => {
  it('recognises the ways a server says no', () => {
    expect(isAuthFailure({ code: 530, message: 'Not logged in' })).toBe(true);
    expect(
      isAuthFailure(new Error('All configured authentication methods failed'))
    ).toBe(true);
    expect(isAuthFailure(new Error('Permission denied (publickey,password)'))).toBe(
      true
    );
  });

  it('does not mistake a network problem for a bad password', () => {
    expect(isAuthFailure({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })).toBe(
      false
    );
    expect(isAuthFailure(new Error('Timeout while connecting to server'))).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
  });
});
