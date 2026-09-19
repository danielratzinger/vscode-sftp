import * as fse from 'fs-extra';
import { Discovery, discoveryPath } from './discovery';

/**
 * Every VS Code window runs its own extension host, so every window would
 * otherwise try to be the server. One of them takes the port; the rest stand
 * down and try again later, so closing the leader hands the role on rather
 * than leaving nothing listening.
 *
 * The port doubles as the lock: binding it is atomic, which no file-based
 * scheme can claim.
 */

export const DEFAULT_PORT = 7391;

export function isAddressInUse(error: any): boolean {
  return Boolean(error) && error.code === 'EADDRINUSE';
}

/** Whether a process is still there, without signalling it. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH means gone; EPERM means alive but not ours to touch.
    return error && error.code === 'EPERM';
  }
}

export interface PortVerdict {
  /** Another window of this extension holds the port. */
  heldByPeer: boolean;
  /** Something else holds it; ours should move rather than never start. */
  heldByStranger: boolean;
  peer?: Discovery;
}

/**
 * Who has the port we wanted.
 *
 * A peer leaves its details behind, so a matching port with a live pid is one
 * of ours. Anything else on that port is a stranger, and losing the race to it
 * must not mean never serving at all.
 */
export async function whoHasThePort(port: number): Promise<PortVerdict> {
  let peer: Discovery | undefined;

  try {
    peer = JSON.parse(await fse.readFile(discoveryPath(), 'utf8'));
  } catch (error) {
    peer = undefined;
  }

  if (peer && peer.port === port && peer.pid && isAlive(peer.pid)) {
    return { heldByPeer: true, heldByStranger: false, peer };
  }

  return { heldByPeer: false, heldByStranger: true, peer };
}
