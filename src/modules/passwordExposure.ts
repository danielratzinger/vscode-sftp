import * as vscode from 'vscode';
import logger from '../logger';
import { getUserSetting, showModalWarning } from '../host';
import {
  Exposure,
  exposureOf,
  worthWarningAbout,
} from '../core/credentialExposure';

/**
 * Asking before a password goes out in the clear.
 *
 * Once per server per window: a question that appears on every connection
 * gets dismissed without being read, which is worse than not asking. The
 * answer can also be kept for good, per server, because a plain-FTP host on a
 * network you trust is a decision somebody is entitled to make once.
 */

const accepted = new Set<string>();
const REMEMBERED = 'sftp.cleartextAccepted';

let storage: vscode.Memento | undefined;

export function initPasswordExposure(context: vscode.ExtensionContext): void {
  storage = context.globalState;
}

function keyFor(config: { host?: string; port?: number; username?: string }): string {
  return `${config.username || ''}@${config.host || ''}:${config.port || ''}`;
}

function remembered(): string[] {
  return storage ? storage.get<string[]>(REMEMBERED, []) : [];
}

/**
 * Returns false when the user would rather not connect.
 *
 * Never throws and never blocks anything but the connection it is asked
 * about: a warning that breaks the extension would be worse than the problem.
 */
export async function confirmExposure(config: any): Promise<boolean> {
  try {
    const report = exposureOf(config);
    if (!worthWarningAbout(report.level)) {
      if (report.level === Exposure.Unverified) {
        logger.info(`[security] ${report.headline}`);
      }
      return true;
    }

    if (!getUserSetting('sftp').get<boolean>('warnOnCleartextPassword', true)) {
      return true;
    }

    const key = keyFor(config);
    if (accepted.has(key) || remembered().indexOf(key) !== -1) {
      return true;
    }

    logger.warn(`[security] ${report.headline}`);

    const answer = await showModalWarning(
      report.headline,
      report.detail,
      'Connect Anyway',
      'Always Allow for This Server'
    );

    if (answer === 'Always Allow for This Server') {
      accepted.add(key);
      if (storage) {
        await storage.update(REMEMBERED, remembered().concat(key));
      }
      return true;
    }

    if (answer === 'Connect Anyway') {
      // For this window only: the next one asks again, because the network
      // this machine is on may not be the same network.
      accepted.add(key);
      return true;
    }

    logger.info('[security] connection cancelled rather than send a cleartext password');
    return false;
  } catch (error) {
    logger.debug(`could not check credential exposure: ${error.message}`);
    return true;
  }
}
