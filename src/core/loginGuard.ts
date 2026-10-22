import * as crypto from 'crypto';

/**
 * Not asking a server again with credentials it has just refused.
 *
 * Every connection here retries: autosync on a timer, a transfer that failed,
 * an agent's MCP call, a tree refreshing itself. Against a server that has
 * refused the password, each of those is another failed login - and a few of
 * those in a minute is what fail2ban, Plesk and most hosts lock an address out
 * for, which is how the same person kept locking themselves out of their own
 * servers.
 *
 * So a refused login pauses that login. While paused, nothing tries on its
 * own; a new attempt is allowed only when
 *
 * - someone asks for it - expands or refreshes the connection in the Remote
 *   Explorer - or the password has changed, and in both cases no more than
 *   once every ten seconds;
 * - or a quarter of an hour has passed since the last attempt, when any
 *   request may try once.
 *
 * A password changed on the server, with the same one kept here, is covered by
 * the first; one changed in the editor or a password manager, by both. An
 * attempt that fails starts the pause again; one that succeeds ends it.
 *
 * Kept by login - protocol, user, host and port - since that is what a server
 * counts failures against, and two projects on one account share the count.
 */

export const AT_MOST_EVERY = 10 * 1000;
export const ON_ITS_OWN_AFTER = 15 * 60 * 1000;
/** How often a silent password store is read again to see if it changed. */
export const LOOK_FOR_A_NEW_PASSWORD_EVERY = 60 * 1000;

export interface Paused {
  /** The last attempt, allowed or not counted - the time the rules measure from. */
  lastAttempt: number;
  /** A one-way fingerprint of what was refused, never the secret itself. */
  refused?: string;
  /** When the password store was last read to compare against it. */
  lastLooked?: number;
}

export type Verdict =
  | { allowed: true; why: 'not paused' | 'asked for' | 'changed' | 'time passed' }
  | { allowed: false; retryIn: number };

export interface Asking {
  /** Someone asked for this login, in the Remote Explorer. */
  explicit?: boolean;
  /** The credentials as they are now, fingerprinted; undefined if not read. */
  fingerprint?: string;
}

export function loginKey(option: {
  protocol?: string;
  username?: string;
  host?: string;
  port?: number;
}): string {
  return `${option.protocol || ''}://${option.username || ''}@${option.host || ''}:${option.port || ''}`;
}

/** A fingerprint of what is sent to log in, salted per process, never stored. */
const SALT = crypto.randomBytes(16).toString('hex');
export function fingerprintOf(...secrets: Array<string | undefined>): string {
  return crypto
    .createHash('sha256')
    .update(SALT)
    .update(secrets.map(one => (one === undefined ? '\u0000' : one)).join('\u0001'))
    .digest('hex');
}

export class LoginGuard {
  private _paused = new Map<string, Paused>();
  private _askedFor = new Map<string, number>();

  constructor(private _now: () => number = Date.now) {}

  isPaused(key: string): boolean {
    return this._paused.has(key);
  }

  /** Someone asked for this login; good for the next attempt within a few seconds. */
  askFor(key: string): void {
    this._askedFor.set(key, this._now());
  }

  private _wasAskedFor(key: string): boolean {
    const at = this._askedFor.get(key);
    return at !== undefined && this._now() - at < 5000;
  }

  /**
   * Whether it is worth reading the password store to look for a change, for
   * a store that reads without asking anybody anything.
   */
  worthLooking(key: string): boolean {
    const paused = this._paused.get(key);
    if (!paused) {
      return true;
    }
    return (
      this._wasAskedFor(key) ||
      this._now() - paused.lastAttempt >= ON_ITS_OWN_AFTER ||
      this._now() - (paused.lastLooked || 0) >= LOOK_FOR_A_NEW_PASSWORD_EVERY
    );
  }

  mayTry(key: string, asking: Asking = {}): Verdict {
    const paused = this._paused.get(key);
    if (!paused) {
      return { allowed: true, why: 'not paused' };
    }

    const now = this._now();
    const since = now - paused.lastAttempt;
    if (asking.fingerprint !== undefined) {
      paused.lastLooked = now;
    }

    if (since >= ON_ITS_OWN_AFTER) {
      paused.lastAttempt = now;
      return { allowed: true, why: 'time passed' };
    }

    if (since < AT_MOST_EVERY) {
      return { allowed: false, retryIn: AT_MOST_EVERY - since };
    }

    const explicit = asking.explicit || this._wasAskedFor(key);
    const changed =
      asking.fingerprint !== undefined &&
      paused.refused !== undefined &&
      asking.fingerprint !== paused.refused;

    if (explicit || changed) {
      paused.lastAttempt = now;
      this._askedFor.delete(key);
      return { allowed: true, why: explicit ? 'asked for' : 'changed' };
    }

    return { allowed: false, retryIn: ON_ITS_OWN_AFTER - since };
  }

  /**
   * A password was just changed here: the next request reads the store again
   * at once rather than within the minute, and only a login whose password
   * actually changed is tried.
   */
  lookAgain(): void {
    this._paused.forEach(paused => {
      paused.lastLooked = 0;
    });
  }

  /** The server refused these credentials. */
  refused(key: string, fingerprint?: string): void {
    const now = this._now();
    this._paused.set(key, { lastAttempt: now, refused: fingerprint, lastLooked: now });
  }

  /** It let us in: nothing to hold back any more. */
  succeeded(key: string): void {
    this._paused.delete(key);
    this._askedFor.delete(key);
  }
}

/**
 * Whether a failure to connect was the server refusing the credentials, as
 * opposed to anything else going wrong on the way. Only that pauses a login:
 * an unreachable server costs nothing to try again.
 */
export function isRefusedLogin(error: any): boolean {
  if (!error) {
    return false;
  }
  if (error.level === 'client-authentication' || Number(error.code) === 530) {
    return true;
  }
  return /all configured authentication methods failed|authentication failed|login incorrect|not logged in|530 /i.test(
    String(error.message || '')
  );
}
