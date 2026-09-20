import * as vscode from 'vscode';
import logger from '../logger';
import { getUserSetting } from '../host';
import { Support, withTls } from '../core/ftpsPolicy';

/**
 * What is known about each server's willingness to speak TLS.
 *
 * Nothing here predicts anything. A server is tried, and remembered as
 * failed the moment something goes wrong on an upgraded connection - at
 * login, at a listing, or in the middle of a transfer. A failure is kept for
 * a day rather than for ever, because the usual causes are a firewall rule or
 * a missing certificate, and both get fixed.
 */

const REMEMBERED = 'sftp.ftpsSupport';
const FORGET_FAILURE_AFTER = 24 * 60 * 60 * 1000;

let storage: vscode.Memento | undefined;

export function initFtpsUpgrade(context: vscode.ExtensionContext): void {
  storage = context.globalState;
}

export function keyFor(option: { host?: string; port?: number }): string {
  return `${option.host || ''}:${option.port || 21}`;
}

function kept(): { [key: string]: { support: Support; at: number } } {
  return storage ? storage.get(REMEMBERED, {}) : {};
}

function recall(key: string): Support {
  const entry = kept()[key];
  if (!entry) {
    return Support.Untried;
  }

  if (entry.support === Support.Failed && Date.now() - entry.at > FORGET_FAILURE_AFTER) {
    return Support.Untried;
  }

  return entry.support;
}

function remember(key: string, support: Support): void {
  if (!storage) {
    return;
  }

  const all = kept();
  all[key] = { support, at: Date.now() };
  storage.update(REMEMBERED, all);
}

function enabled(): boolean {
  return getUserSetting('sftp').get<boolean>('upgradePlainFtp', true);
}

/**
 * The option to connect with: the configured one, or the same with TLS added
 * where that is worth attempting.
 */
export function upgradeIfWorthTrying(option: any): any {
  try {
    if (option.protocol !== 'ftp' || option.secure || !enabled()) {
      return option;
    }

    const key = keyFor(option);
    if (recall(key) === Support.Failed) {
      return option;
    }

    return withTls(option);
  } catch (error) {
    logger.debug(`could not decide about FTPS: ${error.message}`);
    return option;
  }
}

/** Called when an upgraded connection worked, so the log says so once. */
export function noteUpgradeWorked(option: any): void {
  const key = keyFor(option);
  if (recall(key) === Support.Working) {
    return;
  }

  remember(key, Support.Working);
  logger.info(
    `[security] ${key} accepts FTPS; using it instead of plain FTP. The ` +
      'certificate is not verified - set "secure": true in sftp.json for that.'
  );
}

/** Called when an upgraded connection let us down, at any point. */
export function noteUpgradeFailed(option: any, reason: string): void {
  const key = keyFor(option);
  remember(key, Support.Failed);
  logger.warn(
    `[security] ${key} did not work over TLS (${reason}); falling back to the ` +
      'connection as configured. Plain FTP sends the password as readable ' +
      'text. This is usually a firewall that cannot see PASV once the control ' +
      'channel is encrypted, or a server that wants the data connection to ' +
      'reuse the control session.'
  );
}

export function forgetFtpsSupport(): void {
  if (storage) {
    storage.update(REMEMBERED, {});
  }
}
