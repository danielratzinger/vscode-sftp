import {
  Exposure,
  exposureOf,
  sendsAPassword,
  worthWarningAbout,
} from '../credentialExposure';

const ftp = (over: object = {}) => ({
  protocol: 'ftp',
  host: 'files.example.com',
  password: 'secret',
  ...over,
});

describe('exposureOf', () => {
  it('calls plain FTP what it is', () => {
    const report = exposureOf(ftp());

    expect(report.level).toBe(Exposure.Cleartext);
    expect(report.headline).toContain('cleartext');
    // Naming the fix matters more than naming the problem.
    expect(report.detail).toContain('"secure": true');
    expect(worthWarningAbout(report.level)).toBe(true);
  });

  it('is satisfied by FTPS', () => {
    // node-ftp sends AUTH TLS before USER, and errors rather than continuing
    // unprotected if the server refuses.
    expect(exposureOf(ftp({ secure: true })).level).toBe(Exposure.Protected);
    expect(exposureOf(ftp({ secure: 'implicit' })).level).toBe(Exposure.Protected);
    expect(exposureOf(ftp({ secure: 'control' })).level).toBe(Exposure.Protected);
  });

  it('separates encrypted-but-unverified from both extremes', () => {
    const report = exposureOf(
      ftp({ secure: true, secureOptions: { rejectUnauthorized: false } })
    );

    expect(report.level).toBe(Exposure.Unverified);
    expect(report.headline).toContain('not verified');
    // Not worth a modal: nobody can read it passively.
    expect(worthWarningAbout(report.level)).toBe(false);
  });

  it('never warns about SFTP, whatever the credential', () => {
    ['password', 'passwordManager', 'passwordCommand'].forEach(key =>
      expect(
        exposureOf({ protocol: 'sftp', host: 'h', [key]: 'x' } as any).level
      ).toBe(Exposure.Protected)
    );
  });

  it('says nothing when no password is sent at all', () => {
    const report = exposureOf({
      protocol: 'sftp',
      host: 'h',
      privateKeyPath: '/Users/x/.ssh/id_rsa',
    });

    expect(report.level).toBe(Exposure.None);
  });

  it('warns about a cleartext password that has not been typed yet', () => {
    // No password in the file means it will be asked for - and then sent the
    // same way.
    expect(exposureOf({ protocol: 'ftp', host: 'h' }).level).toBe(
      Exposure.Cleartext
    );
  });

  it('defaults to SFTP when no protocol is named, as the config does', () => {
    expect(exposureOf({ host: 'h', password: 'x' }).level).toBe(
      Exposure.Protected
    );
  });
});

describe('sendsAPassword', () => {
  it('knows a key authenticates without one', () => {
    expect(sendsAPassword({ privateKeyPath: '/k' })).toBe(false);
    expect(sendsAPassword({ agent: '/tmp/agent' })).toBe(false);
  });

  it('counts every way a password can arrive', () => {
    expect(sendsAPassword({ password: 'x' })).toBe(true);
    expect(sendsAPassword({ passwordManager: 'keychain' })).toBe(true);
    expect(sendsAPassword({ passwordCommand: 'op read x' })).toBe(true);
    // Nothing configured: it will be asked for.
    expect(sendsAPassword({})).toBe(true);
  });

  it('respects a key with passwordManager switched off', () => {
    expect(
      sendsAPassword({ privateKeyPath: '/k', passwordManager: false })
    ).toBe(false);
  });
});
