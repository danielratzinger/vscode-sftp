import SSHClient from '../sshClient';
import { setHostKeyChecker } from '../hostKeys';

/**
 * The invariant a whole afternoon of green tests missed.
 *
 * ssh2 advertises `ext-info-c`, so an OpenSSH server sends `EXT_INFO` in the
 * same breath as `NEWKEYS`, encrypted under the new keys. ssh2 only switches
 * its decipher once the host verifier has answered - so a verifier that
 * returns `undefined` and answers later leaves that packet to be decrypted
 * with the old cipher, and the connection dies with `Bad packet length`.
 *
 * The e2e suite could not catch it, because ssh2's own server implementation
 * does not send `EXT_INFO`. What can be checked anywhere is the shape: the
 * function handed to ssh2 must return a boolean, there and then. Awaiting
 * anything inside it - even a file already in the page cache - is too slow.
 */

const key = Buffer.from('a key');

function verifierFor(option: any): any {
  const client = new SSHClient(option);
  return (client as any)._verifier(option);
}

afterEach(() => setHostKeyChecker(undefined));

describe('the function ssh2 is given to check a host key', () => {
  it('answers with a boolean rather than promising one', () => {
    setHostKeyChecker({
      prepare: async () => undefined,
      decide: () => true,
      askAgain: async () => false,
    });

    const answer = verifierFor({ host: 'example.com', port: 22 })(key);

    expect(typeof answer).toBe('boolean');
    expect(answer).toBe(true);
  });

  it('answers with a boolean when it refuses, too', () => {
    setHostKeyChecker({
      prepare: async () => undefined,
      decide: () => false,
      askAgain: async () => false,
    });

    expect(verifierFor({ host: 'example.com', port: 22 })(key)).toBe(false);
  });

  it('refuses rather than throwing when the checker breaks', () => {
    setHostKeyChecker({
      prepare: async () => undefined,
      decide: () => {
        throw new Error('no');
      },
      askAgain: async () => false,
    });

    expect(verifierFor({ host: 'example.com', port: 22 })(key)).toBe(false);
  });

  it('is not given at all when nothing is checking', () => {
    setHostKeyChecker(undefined);

    expect(verifierFor({ host: 'example.com', port: 22 })).toBeUndefined();
  });

  it('is not given at all when the connection opted out', () => {
    setHostKeyChecker({
      prepare: async () => undefined,
      decide: () => true,
      askAgain: async () => false,
    });

    expect(
      verifierFor({ host: 'example.com', port: 22, hostVerification: false })
    ).toBeUndefined();
  });
});
