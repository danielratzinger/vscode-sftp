import * as net from 'net';

/**
 * Asking a plain FTP server whether it would rather speak TLS.
 *
 * A great many hosts accept FTPS and never mention it: the configuration
 * everyone copies says `"protocol": "ftp"`, nobody adds `"secure": true`, and
 * the password goes out in the clear for years. The server knows the answer
 * and will say so if asked - `FEAT` lists `AUTH TLS` before anyone has
 * authenticated.
 *
 * The probe is deliberately its own short-lived connection that sends nothing
 * but `FEAT` and `QUIT`. No username, no password, no state to unpick if it
 * fails: the worst case is a connection that told us nothing, and the caller
 * carries on exactly as it would have.
 */

export const enum Support {
  /** `FEAT` listed AUTH TLS. */
  Tls = 'tls',
  /** The server answered and did not offer it. */
  None = 'none',
  /** No usable answer; assume nothing. */
  Unknown = 'unknown',
}

export interface ProbeOption {
  host: string;
  port?: number;
  /** The whole probe, not each step. */
  timeout?: number;
}

/** True when a FEAT listing offers TLS. */
export function offersTls(featResponse: string): boolean {
  return /^\s*AUTH[\s-]+(TLS|SSL)/im.test(featResponse);
}

export function probeFtps(option: ProbeOption): Promise<Support> {
  const timeout = option.timeout === undefined ? 5000 : option.timeout;

  return new Promise<Support>(resolve => {
    let settled = false;
    let buffer = '';
    let sentFeat = false;

    const socket = new net.Socket();

    const finish = (support: Support) => {
      if (settled) {
        return;
      }
      settled = true;

      try {
        socket.write('QUIT\r\n');
      } catch (error) {
        // Nothing depends on a tidy goodbye.
      }
      socket.destroy();
      resolve(support);
    };

    const timer = setTimeout(() => finish(Support.Unknown), timeout);
    if (typeof (timer as any).unref === 'function') {
      (timer as any).unref();
    }

    socket.setTimeout(timeout);
    socket.on('timeout', () => finish(Support.Unknown));
    socket.on('error', () => finish(Support.Unknown));
    socket.on('close', () => {
      clearTimeout(timer as any);
      finish(Support.Unknown);
    });

    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');

      // The greeting is a 2xx; anything else means this is not a server we
      // can ask.
      if (!sentFeat) {
        if (!/^\d{3}[ -]/m.test(buffer)) {
          return;
        }
        if (!/^2\d\d[ ]/m.test(buffer)) {
          return finish(Support.Unknown);
        }

        sentFeat = true;
        buffer = '';
        socket.write('FEAT\r\n');
        return;
      }

      // A feature block opens with `211-` and closes with `211 `; a server
      // that has never heard of FEAT answers in one line. The closing line is
      // matched anywhere in the buffer, because the buffer ends with the
      // newline after it.
      if (/^(?:211 |500|502|530|550)/m.test(buffer)) {
        return finish(offersTls(buffer) ? Support.Tls : Support.None);
      }

      if (offersTls(buffer)) {
        finish(Support.Tls);
      }
    });

    socket.connect(option.port || 21, option.host);
  });
}

/**
 * The connection option to use, given what the server said.
 *
 * Kept here, away from the editor, because what it decides is worth stating
 * plainly: an upgrade only ever adds TLS to a connection that had none, never
 * changes one the configuration asked for, and never overrides a
 * `secureOptions` the user wrote themselves.
 */
export function withTls(option: any, support: Support): any {
  if (
    option.protocol !== 'ftp' ||
    option.secure ||
    support !== Support.Tls
  ) {
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
