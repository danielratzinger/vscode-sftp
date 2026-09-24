import {
  accountOfKey,
  siblingsOf,
  withKey,
  withoutKey,
} from '../credentialKeys';

/**
 * A credential is keyed by the account and the connection's name, so renaming
 * a connection moves its password out of reach - and a new connection taking
 * the freed name inherits it. Nothing else about a connection is stable enough
 * to key on: the name, the `remotePath` and the `context` can all change. Only
 * the account cannot, so what the exact key cannot answer, the account does.
 */

const A = 'password:sftp://dr@univers.metanet.ch:2121/sportswise.com';
const B = 'password:sftp://dr@univers.metanet.ch:2121/ratzinger.cc';
const ELSEWHERE = 'password:sftp://dr@seth.metanet.ch:22/audiowien.at';
const NO_NAME = 'password:sftp://dr@univers.metanet.ch:2121';

describe('the account a key belongs to', () => {
  it('is everything before the project name', () => {
    expect(accountOfKey(A)).toBe('password:sftp://dr@univers.metanet.ch:2121');
  });

  it('is the whole key when no project is named', () => {
    expect(accountOfKey(NO_NAME)).toBe('password:sftp://dr@univers.metanet.ch:2121');
  });

  it('puts two projects on one account together', () => {
    expect(accountOfKey(A)).toBe(accountOfKey(B));
  });

  it('keeps another host apart', () => {
    expect(accountOfKey(A)).not.toBe(accountOfKey(ELSEWHERE));
  });

  it('keeps a passphrase apart from a password', () => {
    // A passphrase is keyed by the file it unlocks and has nothing to do with
    // a connection being renamed.
    expect(accountOfKey('passphrase:/Users/x/.ssh/id_ed25519')).not.toBe(
      accountOfKey(NO_NAME)
    );
  });
});

describe('the keys that could be the same connection renamed', () => {
  it('is the ones on that account, not itself', () => {
    expect(siblingsOf(A, [A, B, ELSEWHERE])).toEqual([B]);
  });

  it('is nothing when the account has only this one', () => {
    expect(siblingsOf(A, [A, ELSEWHERE])).toEqual([]);
  });
});

describe('the order the candidates come in', () => {
  it('is the order the store gave them', () => {
    // The keychain lists newest change first, and that is the whole of the
    // choosing: where several records could answer for one login, the most
    // recently written one is taken. Nothing here reorders them.
    const newestFirst = [B, 'password:sftp://dr@univers.metanet.ch:2121/x.at'];

    expect(siblingsOf(A, [A].concat(newestFirst))).toEqual(newestFirst);
  });
});

describe('keeping the list', () => {
  it('adds a key once', () => {
    expect(withKey(withKey([], A), A)).toEqual([A]);
  });

  it('removes one', () => {
    expect(withoutKey([A, B], A)).toEqual([B]);
  });
});
