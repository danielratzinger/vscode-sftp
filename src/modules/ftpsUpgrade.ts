import * as vscode from 'vscode';
import logger from '../logger';
import { getUserSetting } from '../host';
import {
  probeFtps,
  Support,
  verifyFtpsSession,
  withTls,
} from '../core/ftpsProbe';

/**
 * Turning a plain FTP connection into an encrypted one, without being asked.
 *
 * The upgrade is opportunistic, in the sense the word has in mail: the
 * alternative is not a verified connection, it is a password in plain view,
 * so an encrypted connection to a server whose certificate nobody checked is
 * strictly better than what would otherwise happen. It is not as good as
 * `"secure": true` in the configuration, which verifies the certificate, and
 * the log says which of the two happened.
 *
 * The answer is remembered per host so this costs one extra connection the
 * first time and nothing afterwards.
 */

const REMEMBERED = 'sftp.ftpsSupport';
const TTL = 7 * 24 * 60 * 60 * 1000;

let storage: vscode.Memento | undefined;
const thisSession: { [key: string]: Support } = {};

export function initFtpsUpgrade(context: vscode.ExtensionContext): void {
  storage = context.globalState;
}

function keyFor(host: string, port?: number): string {
  return `${host}:${port || 21}`;
}

function recall(key: string): Support | undefined {
  if (thisSession[key]) {
    return thisSession[key];
  }

  const kept = storage
    ? storage.get<{ [key: string]: { support: Support; at: number } }>(REMEMBERED, {})
    : {};
  const entry = kept[key];

  // Servers change. A remembered "no" should not outlive a certificate being
  // installed by more than a few days.
  return entry && Date.now() - entry.at < TTL ? entry.support : undefined;
}

async function remember(key: string, support: Support): Promise<void> {
  thisSession[key] = support;
  if (!storage) {
    return;
  }

  const kept = storage.get<any>(REMEMBERED, {});
  kept[key] = { support, at: Date.now() };
  await storage.update(REMEMBERED, kept);
}

/**
 * Returns the connection option to use, which is the one given unless the
 * server turns out to accept TLS.
 */
export async function upgradeIfPossible(option: any): Promise<any> {
  try {
    if (
      option.protocol !== 'ftp' ||
      option.secure ||
      !getUserSetting('sftp').get<boolean>('upgradePlainFtp', true)
    ) {
      return option;
    }

    const key = keyFor(option.host, option.port);
    let support = recall(key);

    if (support === undefined) {
      // Cheap first: a server that does not offer TLS at all is settled
      // without a login.
      support = await probeFtps({
        host: option.host,
        port: option.port,
        timeout: option.connectTimeout,
      });

      // Offered is not the same as working. FTP runs commands over one
      // connection and listings and file contents over another, and
      // encryption can succeed on the first and fail on the second - so the
      // second test is a real session: log in over TLS and list a directory,
      // which is exactly what would break.
      if (support === Support.Tls) {
        const works = await verifyFtpsSession({
          host: option.host,
          port: option.port,
          user: option.username,
          password:
            typeof option.password === 'string' ? option.password : undefined,
          path: option.remotePath,
          timeout: option.connectTimeout,
        });

        if (!works) {
          support = Support.ControlOnly;
          logger.info(
            `[security] ${key} offers FTPS, but listing a directory over it ` +
              'did not work, so the connection stays as configured. That is ' +
              'usually a firewall that cannot see PASV once the control ' +
              'channel is encrypted, or a server that wants the data ' +
              'connection to reuse the control session.'
          );
        }
      }

      await remember(key, support);
    }

    const upgraded = withTls(option, support);
    if (upgraded === option) {
      return option;
    }

    logger.info(
      `[security] ${key} accepts FTPS; connecting with TLS instead of plain ` +
        'FTP. The certificate is not verified - set "secure": true in ' +
        'sftp.json for that.'
    );

    return upgraded;
  } catch (error) {
    logger.debug(`could not probe for FTPS: ${error.message}`);
    return option;
  }
}

/** Forgets what was learned, for a server that has changed. */
export function forgetFtpsSupport(): void {
  Object.keys(thisSession).forEach(key => delete thisSession[key]);
  if (storage) {
    storage.update(REMEMBERED, {});
  }
}
