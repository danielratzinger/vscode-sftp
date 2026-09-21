jest.mock('fs');

import { vol } from 'memfs';
import * as fse from 'fs-extra';
import { migrateLiteralSecrets } from '../credentialMigration';
import {
  configureCredentials,
  createCredentialResolver,
  SecretStore,
} from '../credentialResolver';

const CONFIG_PATH = '/work/.vscode/sftp.json';

const CONFIG = {
  protocol: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  password: 'hunter2',
  passwordManager: true,
};

function useStore(store: SecretStore) {
  configureCredentials({
    store,
    prompt: async () => undefined,
    runCommand: async () => '',
    runWriteCommand: async () => undefined,
    runProgram: async () => '',
    storeFor: manager => (manager === true ? store : undefined),
    defaultManager: () => true,
  });
}

function workingStore() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key),
    set: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
}

function writeConfigFile(config: object) {
  vol.reset();
  vol.fromJSON({ [CONFIG_PATH]: JSON.stringify(config, null, 4) });
}

async function readConfigFile(): Promise<any> {
  return JSON.parse(await fse.readFile(CONFIG_PATH, 'utf8'));
}

describe('migrateLiteralSecrets', () => {
  it('saves the password and takes it out of the file', async () => {
    const store = workingStore();
    useStore(store);
    writeConfigFile(CONFIG);

    expect(await migrateLiteralSecrets(CONFIG as any, CONFIG_PATH, createCredentialResolver(CONFIG as any))).toBe(true);

    expect(store.values.get('password:sftp://deploy@example.com:22')).toBe(
      'hunter2'
    );

    const after = await readConfigFile();
    expect(after.password).toBe(true);
    expect(after.passwordManager).toBe(true);
    expect(after.host).toBe('example.com');
  });

  it('leaves the file alone when the store will not take it', async () => {
    useStore({
      get: async () => undefined,
      set: async () => {
        throw new Error('keychain is locked');
      },
      delete: async () => undefined,
    });
    writeConfigFile(CONFIG);

    expect(await migrateLiteralSecrets(CONFIG as any, CONFIG_PATH, createCredentialResolver(CONFIG as any))).toBe(false);

    // The only copy of the password is still where it was.
    const after = await readConfigFile();
    expect(after.password).toBe('hunter2');
    expect(after.passwordManager).toBe(true);
  });

  it('leaves the file alone when the store hands back something else', async () => {
    useStore({
      get: async () => 'something else',
      set: async () => undefined,
      delete: async () => undefined,
    });
    writeConfigFile(CONFIG);

    expect(await migrateLiteralSecrets(CONFIG as any, CONFIG_PATH, createCredentialResolver(CONFIG as any))).toBe(false);

    const after = await readConfigFile();
    expect(after.password).toBe('hunter2');
  });

  it('moves a passphrase under the key file it unlocks', async () => {
    const store = workingStore();
    useStore(store);

    const config = {
      ...CONFIG,
      password: undefined,
      passphrase: 'open sesame',
      passphraseManager: true,
      privateKeyPath: '/home/me/.ssh/id_ed25519',
    };
    writeConfigFile(config);

    expect(await migrateLiteralSecrets(config as any, CONFIG_PATH, createCredentialResolver(config as any))).toBe(true);

    expect(store.values.get('passphrase:/home/me/.ssh/id_ed25519')).toBe(
      'open sesame'
    );
    expect((await readConfigFile()).passphrase).toBe(true);
  });

  it('does nothing when the password is already in the store', async () => {
    const store = workingStore();
    useStore(store);

    const config = { ...CONFIG, password: true };
    writeConfigFile(config);

    expect(
      await migrateLiteralSecrets(
        config as any,
        CONFIG_PATH,
        createCredentialResolver(config as any)
      )
    ).toBe(false);

    const after = await readConfigFile();
    expect(after.password).toBe(true);
    expect(store.values.size).toBe(0);
  });

  it('will not rewrite the file on the strength of the global default', async () => {
    const store = workingStore();
    useStore(store);

    // A plain-text password, and no manager named on the connection: the
    // sftp.passwordManager setting decides where credentials go, but it is
    // not licence to start editing someone's config file.
    const config = { ...CONFIG, passwordManager: undefined };
    writeConfigFile(config);

    expect(
      await migrateLiteralSecrets(
        config as any,
        CONFIG_PATH,
        createCredentialResolver(config as any)
      )
    ).toBe(false);

    expect((await readConfigFile()).password).toBe('hunter2');
    expect(store.values.size).toBe(0);
  });

  it('does nothing when the named manager cannot be written to', async () => {
    const store = workingStore();
    useStore(store);

    const config = { ...CONFIG, passwordManager: '1password:op://x/y/z' };
    writeConfigFile(config);

    expect(
      await migrateLiteralSecrets(
        config as any,
        CONFIG_PATH,
        createCredentialResolver(config as any)
      )
    ).toBe(false);

    // The password stays in the file rather than vanishing into nowhere.
    expect((await readConfigFile()).password).toBe('hunter2');
    expect(store.values.size).toBe(0);
  });
});
