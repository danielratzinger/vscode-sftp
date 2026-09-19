/**
 * Whether a password is about to cross the wire where anyone can read it.
 *
 * Plain FTP sends `USER` and `PASS` as text. On a café network, a shared
 * office switch, or any hop between here and the host, that is a password in
 * public. It is worth saying so *before* the connection rather than never,
 * because nothing about the experience afterwards looks any different.
 *
 * The other protocols are fine, and this says so rather than warning about
 * everything until the warning means nothing:
 *
 * - **SFTP** authenticates inside the SSH transport, which is encrypted before
 *   any credential is sent.
 * - **FTPS** (`secure`) issues `AUTH TLS` before `USER`, and the client errors
 *   out rather than continuing unprotected if the server refuses - checked
 *   against node-ftp's own handshake, not assumed.
 * - **FTPS without certificate checking** (`rejectUnauthorized: false`) is
 *   encrypted but unauthenticated: nobody can read the password passively, but
 *   whoever answers the connection can. That is a real but smaller problem, and
 *   it gets its own level rather than being lumped in with either extreme.
 */

export const enum Exposure {
  /** No password is sent at all - a key, or an agent. */
  None = 'none',
  /** Encrypted to a server that proved who it is. */
  Protected = 'protected',
  /** Encrypted, but to whoever answered. */
  Unverified = 'unverified',
  /** Readable by anything on the path. */
  Cleartext = 'cleartext',
}

export interface ExposureReport {
  level: Exposure;
  /** One line, for a notification title. */
  headline: string;
  /** What it means and what to do, for the body. */
  detail: string;
}

interface Connectable {
  protocol?: string;
  host?: string;
  secure?: boolean | string;
  secureOptions?: { rejectUnauthorized?: boolean };
  password?: string | boolean;
  passwordManager?: string | boolean;
  passwordCommand?: string;
  privateKeyPath?: string;
  agent?: string;
  interactiveAuth?: boolean | string[];
}

/** Whether this connection will send a password at all. */
export function sendsAPassword(config: Connectable): boolean {
  if (config.password !== undefined && config.password !== false) {
    return true;
  }
  if (config.passwordManager !== undefined && config.passwordManager !== false) {
    return true;
  }
  if (config.passwordCommand) {
    return true;
  }

  // A key or an agent authenticates without one; anything else will ask.
  return !config.privateKeyPath && !config.agent;
}

export function exposureOf(config: Connectable): ExposureReport {
  const host = config.host || 'the server';

  if (!sendsAPassword(config)) {
    return {
      level: Exposure.None,
      headline: `No password is sent to ${host}.`,
      detail: 'This connection authenticates with a key.',
    };
  }

  if ((config.protocol || 'sftp') !== 'ftp') {
    return {
      level: Exposure.Protected,
      headline: `The password for ${host} is encrypted in transit.`,
      detail: 'SFTP authenticates inside the SSH transport.',
    };
  }

  if (!config.secure) {
    return {
      level: Exposure.Cleartext,
      headline: `The password for ${host} will be sent in cleartext.`,
      detail:
        'Plain FTP sends USER and PASS as readable text, so anything between ' +
        'this machine and the server can read it - and so can anyone who has ' +
        'access to a network on the way. If the server supports FTPS, set ' +
        '"secure": true in sftp.json; if it does not, SFTP on the same host ' +
        'usually does. Until then, treat that password as public.',
    };
  }

  const verifies =
    !config.secureOptions || config.secureOptions.rejectUnauthorized !== false;

  if (verifies) {
    return {
      level: Exposure.Protected,
      headline: `The password for ${host} is encrypted in transit.`,
      detail: 'FTPS negotiates TLS before sending any credential.',
    };
  }

  return {
    level: Exposure.Unverified,
    headline: `The password for ${host} is encrypted, but the server is not verified.`,
    detail:
      'The connection sets "rejectUnauthorized": false, so the certificate is ' +
      'accepted whoever presents it. Nobody can read the password by watching ' +
      'the network, but anything that can answer in the server’s place can ' +
      'collect it. That is usually a self-signed certificate on shared ' +
      'hosting, and usually fine on a network you trust.',
  };
}

/** Whether this level is worth interrupting someone over. */
export function worthWarningAbout(level: Exposure): boolean {
  return level === Exposure.Cleartext;
}
