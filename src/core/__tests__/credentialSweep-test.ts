import {
  accountOf,
  connectionsIn,
  withPasswordChanged,
  secretsIn,
  storedIn,
  withManagersRemoved,
  withSecretsRemoved,
  withSecretsWritten,
} from '../credentialSweep';

/**
 * The file as written, not as it resolves: a profile that names only a
 * password still belongs to its parent's host, and a key built from the
 * profile alone would be `sftp://undefined@undefined:22`.
 */

const file = [
  {
    name: 'sportswise.com',
    host: 'univers.metanet.ch',
    port: 2121,
    username: 'dr',
    password: 'one',
    context: 'sportswise.com',
  },
  {
    name: 'events',
    host: 'web1.st-poelten.at',
    username: 'web',
    password: 'two',
    profiles: {
      staging: { password: 'three' },
      live: { host: 'live.st-poelten.at', password: 'four' },
    },
  },
  {
    name: 'no secret here',
    host: 'clean.example.com',
    username: 'x',
  },
];

describe('finding the connections in a file', () => {
  it('reads an array of them', () => {
    expect(connectionsIn(file).map(one => one.host)).toContain('univers.metanet.ch');
  });

  it('gives a profile its parent’s host and user', () => {
    const staging = connectionsIn(file).find(one => one.password === 'three');

    expect(staging.host).toBe('web1.st-poelten.at');
    expect(staging.username).toBe('web');
  });

  it('lets a profile override what it does say', () => {
    const live = connectionsIn(file).find(one => one.password === 'four');

    expect(live.host).toBe('live.st-poelten.at');
    expect(live.username).toBe('web');
  });
});

describe('what a file is carrying in plain text', () => {
  it('finds every password, profiles included', () => {
    expect(secretsIn(file).map(one => one.value).sort()).toEqual([
      'four',
      'one',
      'three',
      'two',
    ]);
  });

  it('gives a profile its own record, rather than clashing with its parent', () => {
    // The staging profile overrides only the password, so it inherits the
    // host, user and port. Keyed by account alone that was a clash neither
    // secret could survive; keyed per project they are simply two records.
    const staging = secretsIn(file).find(one => one.value === 'three');

    expect(staging!.conflict).toBeUndefined();
    expect(staging!.key).not.toBe(
      secretsIn(file).find(one => one.value === 'two')!.key
    );
  });

  it('still refuses two secrets that really would share one key', () => {
    // Same account and the same name: nothing left to tell them apart.
    const twins = secretsIn([
      { name: 'same', host: 'h.example.com', username: 'u', password: 'one' },
      { name: 'same', host: 'h.example.com', username: 'u', password: 'two' },
    ]);

    expect(twins.find(one => one.value === 'two')!.conflict).toBe(true);
  });

  it('treats the same secret written twice as one', () => {
    const twice = secretsIn([
      { host: 'a.example.com', username: 'u', password: 'same' },
      { host: 'a.example.com', username: 'u', password: 'same' },
    ]);

    expect(twice).toHaveLength(1);
  });

  it('keys each one where it will be looked up', () => {
    const found = secretsIn(file);

    expect(found.find(one => one.value === 'one')!.key).toBe(
      'password:sftp://dr@univers.metanet.ch:2121/sportswise.com'
    );
    // The profile inherits the host, and the default port for sftp.
    expect(found.find(one => one.value === 'three')!.key).toBe(
      'password:sftp://web@web1.st-poelten.at:22/events (staging)'
    );
  });

  it('defaults the port by protocol', () => {
    const found = secretsIn([
      { host: 'ftp.example.com', protocol: 'ftp', username: 'u', password: 'p' },
    ]);

    expect(found[0].key).toBe('password:ftp://u@ftp.example.com:21');
  });

  it('says nothing about a file with no literals', () => {
    expect(secretsIn([{ host: 'a.example.com', password: true }])).toEqual([]);
    expect(secretsIn([{ host: 'a.example.com', password: '' }])).toEqual([]);
  });

  it('names a connection the way a person would recognise it', () => {
    const found = secretsIn(file);

    expect(found.find(one => one.value === 'one')!.label).toBe('sportswise.com');
  });
});

describe('taking the secrets out of the file', () => {
  it('replaces the ones that were moved and nothing else', () => {
    const moved = secretsIn(file).filter(one => one.value !== 'four');
    const after = withSecretsRemoved(JSON.parse(JSON.stringify(file)), moved);

    expect(after[0].password).toBe(true);
    expect(after[1].password).toBe(true);
    expect(after[1].profiles.staging.password).toBe(true);
    // Not moved, so not touched: losing the only copy of a password is worse
    // than leaving it in plain text a little longer.
    expect(after[1].profiles.live.password).toBe('four');
  });

  it('leaves everything that is not a secret alone', () => {
    const after = withSecretsRemoved(
      JSON.parse(JSON.stringify(file)),
      secretsIn(file).filter(one => !one.conflict)
    );

    expect(after[0].context).toBe('sportswise.com');
    expect(after[0].port).toBe(2121);
    expect(after[2]).toEqual({
      name: 'no secret here',
      host: 'clean.example.com',
      username: 'x',
    });
  });
});

/**
 * The other directions. A password can be in a file, in a store, or in
 * something only readable, and the question worth answering is "put them all
 * here" whichever of those it is in now - including back into the files, which
 * is the direction nobody builds and everybody eventually wants.
 */
const stored = [
  {
    name: 'one',
    host: 'a.example.com',
    username: 'u',
    password: true,
    passwordManager: 'keychain',
  },
  {
    name: 'two',
    host: 'b.example.com',
    username: 'u',
    password: true,
  },
  {
    name: 'three',
    host: 'c.example.com',
    username: 'u',
    password: 'still in the file',
  },
];

describe('what is kept in a store rather than the file', () => {
  it('finds the ones marked as stored, and only those', () => {
    expect(storedIn(stored).map(one => one.label)).toEqual(['one', 'two']);
  });

  it('says which store a connection names for itself', () => {
    const found = storedIn(stored);

    expect(found.find(one => one.label === 'one')!.manager).toBe('keychain');
    // Nothing named means the setting decides, which is the caller's to read.
    expect(found.find(one => one.label === 'two')!.manager).toBeUndefined();
  });
});

describe('putting secrets back into the file', () => {
  it('writes each one against the connection it belongs to', () => {
    const after = withSecretsWritten(JSON.parse(JSON.stringify(stored)), {
      'password:sftp://u@a.example.com:22/one': 'first',
      'password:sftp://u@b.example.com:22/two': 'second',
    });

    expect(after[0].password).toBe('first');
    expect(after[1].password).toBe('second');
  });

  it('leaves a connection alone when there is nothing for it', () => {
    const after = withSecretsWritten(JSON.parse(JSON.stringify(stored)), {
      'password:sftp://u@a.example.com:22/one': 'first',
    });

    expect(after[1].password).toBe(true);
    expect(after[2].password).toBe('still in the file');
  });

  it('writes into a profile, against the host it inherited', () => {
    const withProfile = [
      {
        host: 'a.example.com',
        username: 'u',
        profiles: { live: { password: true, remotePath: '/live' } },
      },
    ];

    const after = withSecretsWritten(JSON.parse(JSON.stringify(withProfile)), {
      'password:sftp://u@a.example.com:22': 'inherited',
    });

    expect(after[0].profiles.live.password).toBe('inherited');
    expect(after[0].profiles.live.remotePath).toBe('/live');
  });
});

describe('clearing the managers a connection names for itself', () => {
  it('takes them out so one setting governs all of them', () => {
    const after = withManagersRemoved(JSON.parse(JSON.stringify(stored)));

    expect(after[0].passwordManager).toBeUndefined();
    expect(after[0].host).toBe('a.example.com');
  });

  it('reaches inside profiles too', () => {
    const after = withManagersRemoved([
      { host: 'a.example.com', profiles: { live: { passwordManager: 'vscode' } } },
    ]);

    expect(after[0].profiles.live.passwordManager).toBeUndefined();
  });
});


/**
 * Keeping a record per project costs one thing: six sites on one hosting
 * account hold six copies of the same password. A rotation that updates one of
 * them leaves five connections that will start failing at a time nobody is
 * watching.
 */
describe('which account a record belongs to', () => {
  it('is the part several projects share', () => {
    expect(accountOf('password:sftp://dr@univers.metanet.ch:2121/sportswise.com')).toBe(
      'sftp://dr@univers.metanet.ch:2121'
    );
  });

  it('is the whole of it when no project is named', () => {
    expect(accountOf('password:sftp://dr@example.com:22')).toBe(
      'sftp://dr@example.com:22'
    );
  });

  it('groups two projects on one account together', () => {
    const one = accountOf('password:sftp://k@shared.ch:22/first.ch');
    const two = accountOf('password:sftp://k@shared.ch:22/second.ch');

    expect(one).toBe(two);
  });

  it('keeps two accounts on one host apart', () => {
    expect(accountOf('password:sftp://a@shared.ch:22/x.ch')).not.toBe(
      accountOf('password:sftp://b@shared.ch:22/x.ch')
    );
  });
});

describe('changing one account’s password where it is written down', () => {
  const sites = [
    { name: 'first.ch', host: 'shared.ch', username: 'k', password: 'old' },
    { name: 'second.ch', host: 'shared.ch', username: 'k', password: 'old' },
    { name: 'elsewhere.ch', host: 'other.ch', username: 'k', password: 'old' },
    { name: 'stored.ch', host: 'shared.ch', username: 'k', password: true },
  ];

  const keys = [
    'password:sftp://k@shared.ch:22/first.ch',
    'password:sftp://k@shared.ch:22/second.ch',
    'password:sftp://k@shared.ch:22/stored.ch',
  ];

  it('changes every copy on that account', () => {
    const after = withPasswordChanged(JSON.parse(JSON.stringify(sites)), keys, 'new');

    expect(after[0].password).toBe('new');
    expect(after[1].password).toBe('new');
  });

  it('leaves another account alone', () => {
    const after = withPasswordChanged(JSON.parse(JSON.stringify(sites)), keys, 'new');

    expect(after[2].password).toBe('old');
  });

  it('leaves a stored one saying stored', () => {
    // Its new value belongs in the store it points at, not in the file.
    const after = withPasswordChanged(JSON.parse(JSON.stringify(sites)), keys, 'new');

    expect(after[3].password).toBe(true);
  });
});
