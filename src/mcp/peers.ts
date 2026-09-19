import { ExposedConnection } from './exposure';

/**
 * Making one leader answer for every window.
 *
 * Each window runs its own extension host and knows only its own projects. The
 * leader holds the port, so the others register with it and it forwards any
 * call meant for them. A client sees one server with everything on it, rather
 * than having to know which window has which project open.
 *
 * Ids are namespaced by window, so two windows with a connection numbered 1
 * cannot be confused for one another.
 */

export interface PeerRegistration {
  windowId: string;
  /** Where the leader forwards to. */
  url: string;
  /** The peer's own token, so the leader can authenticate to it. */
  token: string;
  connections: ExposedConnection[];
  workspace?: string;
}

interface Peer extends PeerRegistration {
  lastSeen: number;
}

/** A peer that has not checked in for this long is assumed gone. */
export const PEER_TIMEOUT = 90 * 1000;

export const SEPARATOR = ':';

export function qualify(windowId: string, id: string): string {
  return `${windowId}${SEPARATOR}${id}`;
}

export interface Qualified {
  windowId: string;
  id: string;
}

export function unqualify(qualified: string): Qualified | undefined {
  const at = qualified.indexOf(SEPARATOR);
  if (at <= 0 || at === qualified.length - 1) {
    return undefined;
  }

  return { windowId: qualified.slice(0, at), id: qualified.slice(at + 1) };
}

export class PeerRegistry {
  private _peers = new Map<string, Peer>();
  private _now: () => number;

  constructor(now: () => number = Date.now) {
    this._now = now;
  }

  register(registration: PeerRegistration): void {
    this._peers.set(registration.windowId, {
      ...registration,
      lastSeen: this._now(),
    });
  }

  forget(windowId: string): void {
    this._peers.delete(windowId);
  }

  /** Live peers, oldest registrations swept out first. */
  peers(): Peer[] {
    const now = this._now();

    this._peers.forEach((peer, windowId) => {
      if (now - peer.lastSeen > PEER_TIMEOUT) {
        this._peers.delete(windowId);
      }
    });

    return Array.from(this._peers.values());
  }

  /** Every peer's connections, qualified so ids cannot collide. */
  connections(): ExposedConnection[] {
    const all: ExposedConnection[] = [];

    this.peers().forEach(peer => {
      peer.connections.forEach(connection => {
        all.push({ ...connection, id: qualify(peer.windowId, connection.id) });
      });
    });

    return all;
  }

  /** Which peer owns a qualified id, if any. */
  ownerOf(qualified: string): Peer | undefined {
    const parts = unqualify(qualified);
    if (!parts) {
      return undefined;
    }

    return this.peers().find(peer => peer.windowId === parts.windowId);
  }
}

/**
 * Rewrites a `tools/call` so a peer sees the id it knows itself by.
 *
 * The leader hands out `w2:1`; the window that owns it only ever knew `1`.
 */
export function localiseCall(message: any, qualified: string): any {
  const parts = unqualify(qualified);
  if (!parts) {
    return message;
  }

  return {
    ...message,
    params: {
      ...message.params,
      arguments: { ...(message.params || {}).arguments, server: parts.id },
    },
  };
}

/** The server id a call is aimed at, if it names one. */
export function targetOf(message: any): string | undefined {
  const args =
    message && message.params && message.params.arguments
      ? message.params.arguments
      : undefined;

  return args && typeof args.server === 'string' ? args.server : undefined;
}
