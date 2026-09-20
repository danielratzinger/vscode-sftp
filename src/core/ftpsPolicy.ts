import { isOperationTimeout } from './fs/operationTimeout';

/**
 * Whether a plain FTP connection can quietly be an encrypted one.
 *
 * A great many hosts accept FTPS and never mention it: the configuration
 * everyone copies says `"protocol": "ftp"`, nobody adds `"secure": true`, and
 * the password goes out in the clear for years.
 *
 * The way to find out is to try, and to keep trying only as long as it works.
 * Asking the server what it supports is a weaker question than it appears:
 * FTP runs commands over one connection and listings and file contents over
 * another, encryption can succeed on the first and fail on the second, and a
 * server will happily advertise `AUTH TLS` in either case. A firewall that
 * watched the control channel for `PASV` is blinded once it is encrypted;
 * vsftpd asks by default that the data connection resume the control
 * connection's TLS session, which Node does not do; a server may close a data
 * socket without a TLS `close_notify`, which a short listing survives and a
 * file transfer does not.
 *
 * So the upgrade is attempted, and abandoned for that server the moment
 * anything about it goes wrong - at login, at a listing, or three files into a
 * download. Nothing is predicted; the connection is simply used until it
 * misbehaves, and then it is not used again.
 */

export const enum Support {
  /** Worth trying: nothing has gone wrong yet. */
  Untried = 'untried',
  /** Everything asked of it has worked. */
  Working = 'working',
  /** It failed at something, and is not tried again for a while. */
  Failed = 'failed',
}

export function withTls(option: any): any {
  if (option.protocol !== 'ftp' || option.secure) {
    return option;
  }

  return {
    ...option,
    secure: true,
    // Opportunistic, in the sense the word has in mail: the alternative is
    // not a verified connection, it is a password in plain view. Certificate
    // checking is what `"secure": true` in the configuration buys.
    secureOptions: { rejectUnauthorized: false, ...(option.secureOptions || {}) },
    secureByUpgrade: true,
  };
}

/**
 * Whether a failure is the upgrade's fault rather than the request's.
 *
 * A file that is not there is not a reason to stop using TLS, and treating it
 * as one would drop every connection to plaintext on the first typo. What
 * counts is the transport: a refused or broken data connection, a TLS error,
 * a handshake that did not complete, or a reply in the ranges FTP servers use
 * when a data connection cannot be established.
 */
export function looksLikeTlsTrouble(error: any): boolean {
  if (!error) {
    return false;
  }

  const code = error.code;

  // 425 cannot open data connection, 426 closed mid-transfer, 522 needs a
  // protection level it did not get, 534/536 refused for policy reasons.
  if (typeof code === 'number' && [425, 426, 522, 534, 536].indexOf(code) !== -1) {
    return true;
  }

  if (typeof code === 'string' && /^(ERR_TLS|EPROTO|ECONNRESET|EPIPE|ERR_SSL)/.test(code)) {
    return true;
  }

  // Falling through to the message matters: a refused AUTH TLS arrives as
  // code 500 with "Unable to secure connection(s)", and an early return on
  // the number alone reads that as an ordinary command failure.

  const message = String((error && error.message) || '');

  // `ssl3_get_record` and `tlsv1 alert` are how OpenSSL names its own
  // routines, so the version suffix has to be allowed for.
  return /(\b(secure|handshake|certificate|decryption)\b|\b(tls|ssl)[\w.]*|data connection|wrong version number)/i.test(
    message
  );
}

/**
 * Whether to stop using an upgrade because of this.
 *
 * Wider than `looksLikeTlsTrouble`, because a broken data connection often
 * does not fail at all - it hangs. The client opens a TLS socket to a server
 * that is answering in the clear, neither side says anything, and the
 * operation sits there until its deadline. On a connection the extension
 * encrypted by itself, that silence is the same evidence as an error.
 */
export function isUpgradeTrouble(error: any): boolean {
  return looksLikeTlsTrouble(error) || isOperationTimeout(error);
}
