import {
  AT_MOST_EVERY,
  LOOK_FOR_A_NEW_PASSWORD_EVERY,
  LoginGuard,
  ON_ITS_OWN_AFTER,
  fingerprintOf,
  isRefusedLogin,
  loginKey,
} from '../loginGuard';

const KEY = loginKey({ protocol: 'sftp', username: 'dbstpoe', host: 'orbit.metanet.ch', port: 2121 });

function guard() {
  let now = 1000000;
  const g = new LoginGuard(() => now);
  return { g, wait: (ms: number) => (now += ms) };
}

describe('a login the server refused', () => {
  it('is not tried again on its own', () => {
    const { g, wait } = guard();
    g.refused(KEY, fingerprintOf('wrong'));

    wait(60 * 1000);
    expect(g.mayTry(KEY).allowed).toBe(false);
    wait(10 * 60 * 1000);
    expect(g.mayTry(KEY).allowed).toBe(false);
  });

  it('is tried once more after a quarter of an hour, by anything', () => {
    const { g, wait } = guard();
    g.refused(KEY);

    wait(ON_ITS_OWN_AFTER);
    expect(g.mayTry(KEY)).toEqual({ allowed: true, why: 'time passed' });
    // Once: the next request a moment later waits again.
    wait(1000);
    expect(g.mayTry(KEY).allowed).toBe(false);
  });

  // The server's password changed, the one here did not.
  it('is tried when someone asks, but not more often than every ten seconds', () => {
    const { g, wait } = guard();
    g.refused(KEY);

    wait(3000);
    expect(g.mayTry(KEY, { explicit: true }).allowed).toBe(false);
    wait(AT_MOST_EVERY);
    expect(g.mayTry(KEY, { explicit: true })).toEqual({ allowed: true, why: 'asked for' });
    expect(g.mayTry(KEY, { explicit: true }).allowed).toBe(false);
  });

  it('counts asking in the Remote Explorer for the attempt that follows it', () => {
    const { g, wait } = guard();
    g.refused(KEY);
    wait(AT_MOST_EVERY);

    g.askFor(KEY);
    expect(g.mayTry(KEY)).toEqual({ allowed: true, why: 'asked for' });
    wait(AT_MOST_EVERY);
    // The permission was spent on that attempt.
    expect(g.mayTry(KEY).allowed).toBe(false);
  });

  it('is tried when the password here has changed, not more often than every ten seconds', () => {
    const { g, wait } = guard();
    g.refused(KEY, fingerprintOf('wrong'));

    wait(2000);
    expect(g.mayTry(KEY, { fingerprint: fingerprintOf('right') }).allowed).toBe(false);
    wait(AT_MOST_EVERY);
    expect(g.mayTry(KEY, { fingerprint: fingerprintOf('wrong') }).allowed).toBe(false);
    expect(g.mayTry(KEY, { fingerprint: fingerprintOf('right') })).toEqual({
      allowed: true,
      why: 'changed',
    });
  });

  it('is forgotten once a login works', () => {
    const { g } = guard();
    g.refused(KEY);
    g.succeeded(KEY);

    expect(g.mayTry(KEY)).toEqual({ allowed: true, why: 'not paused' });
    expect(g.isPaused(KEY)).toBe(false);
  });

  // A silent store - the Keychain - is read again at most once a minute.
  it('looks for a new password in a silent store once a minute, no more', () => {
    const { g, wait } = guard();
    g.refused(KEY, fingerprintOf('wrong'));

    expect(g.worthLooking(KEY)).toBe(false);
    wait(LOOK_FOR_A_NEW_PASSWORD_EVERY);
    expect(g.worthLooking(KEY)).toBe(true);
    g.mayTry(KEY, { fingerprint: fingerprintOf('wrong') });
    expect(g.worthLooking(KEY)).toBe(false);
  });

  // Changed with "Change a Server's Password": looked at straight away.
  it('looks again at once when a password has just been changed here', () => {
    const { g, wait } = guard();
    g.refused(KEY, fingerprintOf('wrong'));
    wait(AT_MOST_EVERY);

    expect(g.worthLooking(KEY)).toBe(false);
    g.lookAgain();
    expect(g.worthLooking(KEY)).toBe(true);
    expect(g.mayTry(KEY, { fingerprint: fingerprintOf('right') }).allowed).toBe(true);
  });

  it('keeps one count per login, shared by every project on it', () => {
    const { g } = guard();
    g.refused(KEY);

    expect(g.isPaused(loginKey({ protocol: 'sftp', username: 'dbstpoe', host: 'orbit.metanet.ch', port: 2121 }))).toBe(true);
    expect(g.isPaused(loginKey({ protocol: 'sftp', username: 'other', host: 'orbit.metanet.ch', port: 2121 }))).toBe(false);
  });
});

describe('what counts as the server refusing the login', () => {
  it('is a refused password over SFTP or FTP', () => {
    expect(isRefusedLogin(new Error('[orbit.metanet.ch]: All configured authentication methods failed'))).toBe(true);
    expect(isRefusedLogin(Object.assign(new Error('Login incorrect.'), { code: 530 }))).toBe(true);
    expect(isRefusedLogin({ level: 'client-authentication', message: '' })).toBe(true);
  });

  // An unreachable server costs nothing to try again.
  it('is not a server that could not be reached', () => {
    expect(isRefusedLogin(new Error('[orbit.metanet.ch]: connect ETIMEDOUT 80.74.153.100:2121'))).toBe(false);
    expect(isRefusedLogin(new Error('Timeout while connecting to server'))).toBe(false);
    expect(isRefusedLogin(undefined)).toBe(false);
  });
});

describe('a fingerprint', () => {
  it('tells passwords apart without holding one', () => {
    expect(fingerprintOf('a')).toBe(fingerprintOf('a'));
    expect(fingerprintOf('a')).not.toBe(fingerprintOf('b'));
    expect(fingerprintOf('secret')).not.toContain('secret');
  });
});
