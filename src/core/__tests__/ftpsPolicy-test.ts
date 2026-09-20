import { looksLikeTlsTrouble, withTls } from '../ftpsPolicy';

describe('withTls', () => {
  const plain = { protocol: 'ftp', host: 'h', password: 'p' };

  it('adds TLS to a plain connection', () => {
    const upgraded = withTls(plain);

    expect(upgraded.secure).toBe(true);
    expect(upgraded.secureByUpgrade).toBe(true);
    // Encrypted but unverified: better than the cleartext it replaces, worse
    // than a configured FTPS connection, and the difference is recorded.
    expect(upgraded.secureOptions.rejectUnauthorized).toBe(false);
  });

  it('never touches a connection the configuration already secured', () => {
    const configured = { ...plain, secure: true };
    expect(withTls(configured)).toBe(configured);
  });

  it('never overrides secureOptions somebody wrote', () => {
    const withOwn = {
      ...plain,
      secureOptions: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    };

    const upgraded = withTls(withOwn);

    expect(upgraded.secureOptions.rejectUnauthorized).toBe(true);
    expect(upgraded.secureOptions.minVersion).toBe('TLSv1.2');
  });

  it('does nothing to SFTP', () => {
    const sftp = { protocol: 'sftp', host: 'h' };
    expect(withTls(sftp)).toBe(sftp);
  });
});

describe('looksLikeTlsTrouble', () => {
  it('recognises a data connection that could not be opened', () => {
    // The shape of the failure this whole mechanism exists for: control
    // encrypts, data does not.
    [425, 426, 522, 534, 536].forEach(code =>
      expect(looksLikeTlsTrouble({ code, message: 'Failed' })).toBe(true)
    );
  });

  it('recognises TLS and socket failures', () => {
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'EPROTO', 'ECONNRESET', 'EPIPE'].forEach(code =>
      expect(looksLikeTlsTrouble({ code })).toBe(true)
    );

    expect(looksLikeTlsTrouble(new Error('Unable to secure connection(s)'))).toBe(true);
    expect(looksLikeTlsTrouble(new Error('wrong version number'))).toBe(true);
    expect(looksLikeTlsTrouble(new Error('routines:ssl3_get_record'))).toBe(true);
  });

  it('is not triggered by an ordinary answer about a file', () => {
    // Dropping to plaintext because somebody mistyped a path would be a
    // security regression caused by a typo.
    expect(looksLikeTlsTrouble({ code: 550, message: 'File not found' })).toBe(false);
    expect(looksLikeTlsTrouble({ code: 553, message: 'Permission denied' })).toBe(false);
    expect(looksLikeTlsTrouble(new Error('No such file or directory'))).toBe(false);
    expect(looksLikeTlsTrouble(undefined)).toBe(false);
  });
});

describe('the message matters even when there is a code', () => {
  it('recognises a refused AUTH TLS, which arrives as a 500', () => {
    // What node-ftp actually emits when a server has no certificate -
    // confirmed against it rather than guessed. Reading the number alone
    // calls this an ordinary command failure and keeps using TLS.
    expect(
      looksLikeTlsTrouble({ code: 500, message: 'Unable to secure connection(s)' })
    ).toBe(true);
  });

  it('still ignores an ordinary 500 about a command', () => {
    expect(
      looksLikeTlsTrouble({ code: 500, message: 'Unknown command' })
    ).toBe(false);
  });
});

describe('the floor is your configuration', () => {
  it('never weakens a connection, only ever strengthens one', () => {
    // The invariant worth stating plainly: an upgrade can add TLS to a
    // connection that had none, and nothing here can remove it from one that
    // has it. A configured FTPS connection that fails, fails - it does not
    // quietly become plain FTP.
    const configured = [
      { protocol: 'ftp', host: 'h', secure: true },
      { protocol: 'ftp', host: 'h', secure: 'implicit' },
      { protocol: 'ftp', host: 'h', secure: 'control' },
      { protocol: 'ftp', host: 'h', secure: true, secureOptions: { rejectUnauthorized: true } },
    ];

    configured.forEach(option => {
      const after = withTls(option);
      expect(after).toBe(option);
      expect(after.secure).toBe(option.secure);
    });
  });

  it('leaves certificate checking alone where it was asked for', () => {
    const strict = {
      protocol: 'ftp',
      host: 'h',
      secureOptions: { rejectUnauthorized: true },
    };

    // No `secure`, so this one is upgraded - but the stricter option someone
    // wrote survives the upgrade rather than being replaced by the lenient
    // default an upgrade would otherwise use.
    expect(withTls(strict).secureOptions.rejectUnauthorized).toBe(true);
  });
});
