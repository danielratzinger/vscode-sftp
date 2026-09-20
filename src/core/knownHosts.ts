import { createHash, createHmac } from 'crypto';

/**
 * Reading OpenSSH's `known_hosts`, so trust you already have is trust this
 * extension has too.
 *
 * Every connection here is password authentication - the password is in
 * `sftp.json` - and a password sent to a server whose key was never checked is
 * a password handed to whoever answered. So the key is checked. But the
 * hosts in question are ones you have almost certainly already reached over
 * ssh, and asking again about a machine OpenSSH has trusted for years would be
 * a prompt that teaches people to click through prompts.
 *
 * The format has more in it than it looks. A line may carry a marker
 * (`@revoked`, `@cert-authority`) before anything else. The host field may be
 * a comma-separated list, may use `*` and `?`, may negate with `!`, and is
 * written `[host]:port` whenever the port is not 22. Or it may not be a host
 * at all: `ssh-keygen -H` replaces it with `|1|<salt>|<hash>`, an HMAC-SHA1 of
 * the name under a per-line salt, which cannot be searched for - only tested
 * against, one line at a time.
 *
 * Nothing here talks to a server or the editor: it turns bytes into an answer
 * about one host, which is the part worth being sure of.
 */

export interface HostKeyEntry {
  /** The key as the server presents it, for comparing byte for byte. */
  key: Buffer;
  /** `ssh-ed25519`, `ssh-rsa`, and so on, as the line spells it. */
  type: string;
  /** This key must never be accepted, however it matches. */
  revoked: boolean;
}

export type Verdict = 'unknown' | 'trusted' | 'changed' | 'revoked';

/** `SHA256:abc…`, the fingerprint OpenSSH prints and people compare. */
export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256')
    .update(key)
    .digest('base64')
    .replace(/=+$/, '')}`;
}

/**
 * The key's own idea of its type, read from the blob rather than the line.
 *
 * An SSH public key begins with a length-prefixed string naming its algorithm,
 * which is what the server actually offered - as opposed to what some line in
 * a file claims.
 */
export function typeOf(key: Buffer): string | undefined {
  if (key.length < 4) {
    return undefined;
  }

  const length = key.readUInt32BE(0);
  if (length <= 0 || length > 64 || key.length < 4 + length) {
    return undefined;
  }

  return key.slice(4, 4 + length).toString('ascii');
}

/** How OpenSSH writes a host in `known_hosts`: bare, or `[host]:port`. */
export function hostAs(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** A `known_hosts` pattern, with `*` and `?` meaning what ssh means by them. */
function patternMatches(pattern: string, name: string): boolean {
  if (pattern.indexOf('*') === -1 && pattern.indexOf('?') === -1) {
    return pattern.toLowerCase() === name.toLowerCase();
  }

  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  return new RegExp(`^${expression}$`, 'i').test(name);
}

/** Whether a line's host field covers this name. */
export function fieldCovers(field: string, name: string): boolean {
  if (field.indexOf('|1|') === 0) {
    // |1|<salt>|<hash>: HMAC-SHA1 of the name, keyed by the salt.
    const parts = field.split('|');
    if (parts.length < 4) {
      return false;
    }

    try {
      const expected = createHmac('sha1', Buffer.from(parts[2], 'base64'))
        .update(name)
        .digest('base64');
      return expected === parts[3];
    } catch (error) {
      return false;
    }
  }

  let covered = false;

  for (const pattern of field.split(',')) {
    if (pattern === '') {
      continue;
    }

    if (pattern.charAt(0) === '!') {
      // A negation wins outright, wherever it appears in the list.
      if (patternMatches(pattern.slice(1), name)) {
        return false;
      }
      continue;
    }

    if (patternMatches(pattern, name)) {
      covered = true;
    }
  }

  return covered;
}

/** Every key a `known_hosts` file holds for one host. */
export function keysFor(
  content: string,
  host: string,
  port: number
): HostKeyEntry[] {
  const name = hostAs(host, port);
  const found: HostKeyEntry[] = [];

  for (const line of content.split('\n')) {
    const text = line.trim();
    if (text === '' || text.charAt(0) === '#') {
      continue;
    }

    let fields = text.split(/\s+/);
    let revoked = false;

    if (fields[0].charAt(0) === '@') {
      const marker = fields[0];
      fields = fields.slice(1);

      if (marker === '@revoked') {
        revoked = true;
      } else if (marker !== '@cert-authority') {
        continue; // A marker nobody here understands is a line to leave alone.
      }
    }

    if (fields.length < 3) {
      continue;
    }

    const [field, type, encoded] = fields;
    if (!fieldCovers(field, name)) {
      continue;
    }

    let key: Buffer;
    try {
      key = Buffer.from(encoded, 'base64');
    } catch (error) {
      continue;
    }

    if (key.length === 0) {
      continue;
    }

    found.push({ key, type, revoked });
  }

  return found;
}

/**
 * What to make of the key a server just offered.
 *
 * `changed` and `unknown` are deliberately different answers. Not knowing a
 * host is ordinary - it is the first time you have connected. A key that
 * changed, for a host that has a key on record, is the one thing this exists
 * to catch, and it is not something to resolve by prompting in the same tone.
 */
export function judge(known: HostKeyEntry[], offered: Buffer): Verdict {
  if (known.length === 0) {
    return 'unknown';
  }

  const revoked = known.some(one => one.revoked && one.key.equals(offered));
  if (revoked) {
    return 'revoked';
  }

  const matches = known.some(one => !one.revoked && one.key.equals(offered));
  if (matches) {
    return 'trusted';
  }

  // A host may legitimately offer several key types, and we will only have
  // seen the ones it has offered before. Same type, different key, is a
  // change; a type we have never seen is one we cannot speak to.
  const type = typeOf(offered);
  const sameType = known.some(one => !one.revoked && one.type === type);

  return sameType ? 'changed' : 'unknown';
}
