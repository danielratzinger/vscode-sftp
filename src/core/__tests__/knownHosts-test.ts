import { createHmac, randomBytes } from 'crypto';
import {
  fieldCovers,
  fingerprintOf,
  hostAs,
  judge,
  keysFor,
  typeOf,
} from '../knownHosts';

/**
 * Every connection here authenticates with a password out of `sftp.json`, so a
 * key that is not checked is a password handed to whoever answered. These are
 * the rules that decide whether it gets handed over.
 */

/** A public key blob as ssh writes it: length-prefixed type, then the rest. */
function blob(type: string, body: string): Buffer {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(name.length, 0);
  return Buffer.concat([length, name, Buffer.from(body, 'utf8')]);
}

const ed25519 = blob('ssh-ed25519', 'the-real-key');
const otherKey = blob('ssh-ed25519', 'not-the-same-key');
const rsa = blob('ssh-rsa', 'an-rsa-key');

function line(host: string, key: Buffer, marker = ''): string {
  return `${marker}${marker ? ' ' : ''}${host} ${typeOf(key)} ${key.toString('base64')}`;
}

describe('reading a key', () => {
  it('takes the type from the key itself, not from the line', () => {
    // The line is a claim; the blob is what the server offered.
    expect(typeOf(ed25519)).toBe('ssh-ed25519');
    expect(typeOf(rsa)).toBe('ssh-rsa');
  });

  it('says nothing about bytes that are not a key', () => {
    expect(typeOf(Buffer.from([1, 2]))).toBeUndefined();
    expect(typeOf(Buffer.alloc(8))).toBeUndefined();
  });

  it('prints the fingerprint the way ssh-keygen does', () => {
    const print = fingerprintOf(ed25519);

    expect(print).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(print).not.toContain('=');
  });
});

describe('naming a host the way the file does', () => {
  it('is bare on 22 and bracketed anywhere else', () => {
    expect(hostAs('example.com', 22)).toBe('example.com');
    expect(hostAs('example.com', 2222)).toBe('[example.com]:2222');
  });
});

describe('deciding whether a line is about this host', () => {
  it('matches a plain name, whatever its case', () => {
    expect(fieldCovers('Example.COM', 'example.com')).toBe(true);
    expect(fieldCovers('other.com', 'example.com')).toBe(false);
  });

  it('matches one name out of a list', () => {
    expect(fieldCovers('a.com,example.com,c.com', 'example.com')).toBe(true);
  });

  it('understands the wildcards ssh understands', () => {
    expect(fieldCovers('*.metanet.ch', 'seth.metanet.ch')).toBe(true);
    expect(fieldCovers('*.metanet.ch', 'metanet.ch')).toBe(false);
    expect(fieldCovers('web?.st-poelten.at', 'web1.st-poelten.at')).toBe(true);
  });

  it('lets a negation win wherever it appears', () => {
    expect(fieldCovers('*.metanet.ch,!seth.metanet.ch', 'seth.metanet.ch')).toBe(
      false
    );
    expect(fieldCovers('!seth.metanet.ch,*.metanet.ch', 'seth.metanet.ch')).toBe(
      false
    );
  });

  it('tests a hashed line instead of trying to read it', () => {
    // `ssh-keygen -H` leaves a name that cannot be searched for, only tried.
    const salt = randomBytes(20);
    const hash = createHmac('sha1', salt).update('example.com').digest('base64');
    const field = `|1|${salt.toString('base64')}|${hash}`;

    expect(fieldCovers(field, 'example.com')).toBe(true);
    expect(fieldCovers(field, 'elsewhere.com')).toBe(false);
  });

  it('is not fooled by a hashed line it cannot parse', () => {
    expect(fieldCovers('|1|broken', 'example.com')).toBe(false);
  });
});

describe('pulling a host’s keys out of a file', () => {
  const file = [
    '# a comment',
    '',
    line('example.com', ed25519),
    line('other.com', rsa),
    line('[example.com]:2222', rsa),
  ].join('\n');

  it('finds the keys for that host and no others', () => {
    const found = keysFor(file, 'example.com', 22);

    expect(found).toHaveLength(1);
    expect(found[0].key.equals(ed25519)).toBe(true);
  });

  it('keeps the port apart from the host', () => {
    expect(keysFor(file, 'example.com', 2222)).toHaveLength(1);
    expect(keysFor(file, 'example.com', 2222)[0].key.equals(rsa)).toBe(true);
  });

  it('marks a revoked key as revoked rather than dropping it', () => {
    const found = keysFor(line('example.com', ed25519, '@revoked'), 'example.com', 22);

    expect(found[0].revoked).toBe(true);
  });

  it('reads past a marker it does not understand', () => {
    const found = keysFor(
      `@something-new example.com ssh-ed25519 ${ed25519.toString('base64')}`,
      'example.com',
      22
    );

    expect(found).toEqual([]);
  });

  it('survives a truncated line', () => {
    expect(keysFor('example.com ssh-ed25519', 'example.com', 22)).toEqual([]);
  });
});

describe('judging the key a server offered', () => {
  const known = keysFor(line('example.com', ed25519), 'example.com', 22);

  it('trusts a key it has on record', () => {
    expect(judge(known, ed25519)).toBe('trusted');
  });

  it('calls a host with nothing on record unknown', () => {
    expect(judge([], ed25519)).toBe('unknown');
  });

  it('calls a different key of the same type a change', () => {
    // The one thing this exists to catch.
    expect(judge(known, otherKey)).toBe('changed');
  });

  it('does not call a new key type a change', () => {
    // A host may offer several types and we have only ever seen one of them.
    // Treating that as an attack would cry wolf; it is simply not known.
    expect(judge(known, rsa)).toBe('unknown');
  });

  it('refuses a revoked key even though it matches', () => {
    const revoked = keysFor(line('example.com', ed25519, '@revoked'), 'example.com', 22);

    expect(judge(revoked, ed25519)).toBe('revoked');
  });
});
