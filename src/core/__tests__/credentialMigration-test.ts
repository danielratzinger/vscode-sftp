import {
  detectIndent,
  literalSecretsOf,
  rewriteConfig,
} from '../credentialMigration';

describe('rewriteConfig', () => {
  it('replaces the password with true', () => {
    const before = JSON.stringify(
      {
        name: 'My Server',
        host: 'example.com',
        username: 'deploy',
        password: 'hunter2',
        passwordManager: true,
        remotePath: '/srv',
      },
      null,
      4
    );

    const after = JSON.parse(rewriteConfig(before, { password: 'hunter2' }));

    expect(after.password).toBe(true);
    expect(after.passwordManager).toBe(true);
    // Everything else is left exactly as it was.
    expect(after.name).toBe('My Server');
    expect(after.remotePath).toBe('/srv');
  });

  it('leaves another server\'s password alone', () => {
    const before = JSON.stringify(
      [
        { host: 'a.example.com', password: 'mine', passwordManager: true },
        { host: 'b.example.com', password: 'not mine' },
      ],
      null,
      4
    );

    const after = JSON.parse(rewriteConfig(before, { password: 'mine' }));

    expect(after[0].password).toBe(true);
    expect(after[1].password).toBe('not mine');
  });

  it('reaches a password inside profiles', () => {
    const before = JSON.stringify(
      {
        host: 'example.com',
        passwordManager: true,
        profiles: {
          dev: { password: 'shared' },
          prod: { password: 'shared' },
          other: { password: 'different' },
        },
      },
      null,
      4
    );

    const after = JSON.parse(rewriteConfig(before, { password: 'shared' }));

    expect(after.profiles.dev.password).toBe(true);
    expect(after.profiles.prod.password).toBe(true);
    expect(after.profiles.other.password).toBe('different');
  });

  it('handles the passphrase too', () => {
    const before = JSON.stringify(
      { host: 'example.com', passphrase: 'open sesame', passwordManager: true },
      null,
      4
    );

    const after = JSON.parse(
      rewriteConfig(before, { passphrase: 'open sesame' })
    );

    expect(after.passphrase).toBe(true);
  });

  it('keeps the indentation the file was written with', () => {
    const twoSpace = '{\n  "host": "example.com",\n  "password": "hunter2"\n}';
    expect(rewriteConfig(twoSpace, { password: 'hunter2' })).toContain(
      '\n  "host"'
    );

    const tabbed = '{\n\t"host": "example.com",\n\t"password": "hunter2"\n}';
    expect(rewriteConfig(tabbed, { password: 'hunter2' })).toContain('\n\t"host"');
  });

  it('does not touch a password that is already true', () => {
    const before = JSON.stringify(
      { host: 'example.com', password: true, passwordManager: true },
      null,
      4
    );

    const after = JSON.parse(rewriteConfig(before, {}));

    expect(after.password).toBe(true);
    expect(after.passwordManager).toBe(true);
  });

  it('ends the file with a newline', () => {
    const before = '{\n  "password": "hunter2"\n}';
    expect(rewriteConfig(before, { password: 'hunter2' }).endsWith('\n')).toBe(
      true
    );
  });
});

describe('detectIndent', () => {
  it('reads spaces and tabs off the file', () => {
    expect(detectIndent('{\n  "a": 1\n}')).toBe(2);
    expect(detectIndent('{\n    "a": 1\n}')).toBe(4);
    expect(detectIndent('{\n\t"a": 1\n}')).toBe('\t');
  });

  it('falls back to what a new config is written with', () => {
    expect(detectIndent('{"a":1}')).toBe(4);
  });
});

describe('literalSecretsOf', () => {
  it('picks out only what is written in plain text', () => {
    expect(
      literalSecretsOf({ password: 'hunter2', passphrase: 'open' })
    ).toEqual({ password: 'hunter2', passphrase: 'open' });
  });

  it('ignores the ones that are already elsewhere', () => {
    expect(literalSecretsOf({ password: true, passphrase: true })).toEqual({});
    expect(literalSecretsOf({})).toEqual({});
    // An empty string is not a password worth moving.
    expect(literalSecretsOf({ password: '' })).toEqual({});
  });
});
