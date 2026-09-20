import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import logger from '../logger';
import { getUserSetting } from '../host';
import { HostKeyOption, setHostKeyCheck } from '../core/remote-client/hostKeys';
import {
  HostKeyEntry,
  fingerprintOf,
  judge,
  keysFor,
  typeOf,
} from '../core/knownHosts';

/**
 * Deciding whether to go on talking to a server that just introduced itself.
 *
 * Until now this extension checked nothing: whatever answered on port 22 got
 * the password out of `sftp.json`. That was survivable when a connection
 * happened because somebody pressed save. Autosync connects on its own,
 * repeatedly, on whatever network the machine woke up on, so it is worth
 * knowing that the machine on the other end is the one that was there before.
 *
 * Trust comes from two places, in this order: OpenSSH's own `known_hosts`, so
 * a host you have already accepted in a terminal is not asked about again; and
 * this extension's own store, for the ones you accept here. The second is
 * written separately rather than appended to yours, because adding lines to
 * somebody's `~/.ssh/known_hosts` is not a thing to do without being asked.
 */

const STORE = 'hostKeys.json';

interface Stored {
  type: string;
  key: string;
  addedAt: number;
}

let storeFile = '';

/** One question per host, however many connections are waiting on the answer. */
const asking = new Map<string, Promise<boolean>>();

export function initHostVerification(context: vscode.ExtensionContext): void {
  storeFile = path.join(context.globalStoragePath, STORE);

  setHostKeyCheck(async (host, port, key, option) => {
    if (!enabled()) {
      return true;
    }

    const at = `${host}:${port}`;
    const waiting = asking.get(at);
    if (waiting) {
      return waiting;
    }

    // One question per host, however many connections are waiting on it: 156
    // connections here share 26 hosts, and several of them open at once.
    const answer = decide(host, port, key, option).then(
      ok => {
        asking.delete(at);
        return ok;
      },
      error => {
        asking.delete(at);
        throw error;
      }
    );
    asking.set(at, answer);

    return answer;
  });

  context.subscriptions.push({ dispose: () => setHostKeyCheck(undefined) });
}

function enabled(): boolean {
  return getUserSetting('sftp').get<boolean>('hostVerification', true) !== false;
}

async function readFileOrNothing(file: string): Promise<string> {
  try {
    return await fse.readFile(file, 'utf8');
  } catch (error) {
    return '';
  }
}

async function stored(): Promise<{ [at: string]: Stored[] }> {
  if (!storeFile) {
    return {};
  }

  try {
    return JSON.parse(await fse.readFile(storeFile, 'utf8')) || {};
  } catch (error) {
    return {};
  }
}

/**
 * Everything already on record for this host, ours and OpenSSH's.
 *
 * `knownHostsPath` is whatever the connection's ssh config named, so a setup
 * that keeps its hosts somewhere other than `~/.ssh/known_hosts` is followed
 * rather than ignored.
 */
async function onRecord(
  host: string,
  port: number,
  knownHostsPath?: string
): Promise<HostKeyEntry[]> {
  const files = [
    knownHostsPath,
    path.join(os.homedir(), '.ssh', 'known_hosts'),
  ].filter(Boolean) as string[];

  const found: HostKeyEntry[] = [];

  for (const file of files) {
    found.push(...keysFor(await readFileOrNothing(file), host, port));
  }

  const ours = (await stored())[`${host}:${port}`] || [];
  ours.forEach(one =>
    found.push({
      key: Buffer.from(one.key, 'base64'),
      type: one.type,
      revoked: false,
    })
  );

  return found;
}

/** Writes a key into this extension's own store, replacing one of its type. */
async function remember(host: string, port: number, key: Buffer): Promise<void> {
  if (!storeFile) {
    return;
  }

  const all = await stored();
  const at = `${host}:${port}`;
  const type = typeOf(key) || 'unknown';

  all[at] = (all[at] || []).filter(one => one.type !== type);
  all[at].push({ type, key: key.toString('base64'), addedAt: Date.now() });

  await fse.ensureDir(path.dirname(storeFile));
  await fse.writeFile(storeFile, JSON.stringify(all, null, 2));
}

async function decide(
  host: string,
  port: number,
  key: Buffer,
  option?: HostKeyOption
): Promise<boolean> {
  const print = fingerprintOf(key);
  const type = typeOf(key) || 'unknown';
  const known = await onRecord(host, port, option && option.knownHostsPath);
  const verdict = judge(known, key);

  if (verdict === 'trusted') {
    logger.debug(`host key for ${host} is the one on record (${print})`);
    return true;
  }

  if (verdict === 'revoked') {
    // Revocation is somebody's decision already taken; there is nothing to ask.
    logger.error(
      new Error(`the host key for ${host} is marked revoked in known_hosts`),
      'host key'
    );
    vscode.window.showErrorMessage(
      `${host} offered a host key that is marked revoked in known_hosts. ` +
        'Not connecting.'
    );
    return false;
  }

  if (verdict === 'changed') {
    return askAboutChange(host, port, key, print, type, known);
  }

  // `StrictHostKeyChecking accept-new` means exactly this: a host nobody has
  // seen before is taken on trust, a host whose key changed still is not.
  if (option && option.acceptNew) {
    await remember(host, port, key);
    logger.info(`[host key] ${host} accepted as new (${print}); accept-new is set.`);
    return true;
  }

  return askAboutNew(host, port, key, print, type);
}

async function askAboutNew(
  host: string,
  port: number,
  key: Buffer,
  print: string,
  type: string
): Promise<boolean> {
  const trust = 'Trust';

  const answer = await vscode.window.showWarningMessage(
    `First connection to ${host}. It offers a ${type} key with fingerprint\n\n` +
      `${print}\n\n` +
      'Trust it and remember it for next time?',
    { modal: true, detail: 'Nothing is sent to the server until you answer.' },
    trust
  );

  if (answer !== trust) {
    logger.info(`[host key] ${host} was not trusted; not connecting.`);
    return false;
  }

  await remember(host, port, key);
  logger.info(`[host key] ${host} trusted and remembered (${print}).`);

  return true;
}

/**
 * The key changed, which is the one case this exists to catch.
 *
 * Refused by default and said plainly - but with a way through, because the
 * innocent explanation is common: a server rebuilt, a host moved, a provider
 * rotating keys. What it must not be is a button that is easier to press than
 * to read, so the old and new fingerprints are both on screen and the action
 * says what it does.
 */
async function askAboutChange(
  host: string,
  port: number,
  key: Buffer,
  print: string,
  type: string,
  known: HostKeyEntry[]
): Promise<boolean> {
  const before = known
    .filter(one => one.type === type)
    .map(one => fingerprintOf(one.key))
    .join('\n');

  const update = 'Update the stored key';

  logger.warn(
    `[host key] ${host} offered a ${type} key that is not the one on record. ` +
      `was ${before || 'unknown'}, now ${print}.`
  );

  const answer = await vscode.window.showWarningMessage(
    `The host key for ${host} has changed.`,
    {
      modal: true,
      detail:
        `Was:\n${before || '(not recorded)'}\n\nNow:\n${print}\n\n` +
        'This happens when a server is rebuilt or its keys are rotated. It ' +
        'also happens when something is answering in the server’s place, ' +
        'in which case connecting hands it the password for this connection. ' +
        'Only update the key if you know why it changed.',
    },
    update
  );

  if (answer !== update) {
    logger.info(`[host key] ${host} refused; not connecting.`);
    return false;
  }

  await remember(host, port, key);
  logger.warn(`[host key] ${host} updated to ${print} at your request.`);

  return true;
}
