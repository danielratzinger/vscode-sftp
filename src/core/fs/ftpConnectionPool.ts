import logger from '../../logger';

export interface PooledConnection<T> {
  /** The connected client. Only valid while the lease is held. */
  readonly client: T;
  /** Mark the connection unusable so the pool drops it on release. */
  invalidate(): void;
}

interface Slot<T> {
  client: T;
  busy: boolean;
  broken: boolean;
}

interface Waiter<T> {
  resolve(slot: Slot<T>): void;
  reject(error: Error): void;
}

/**
 * FTP carries a single transfer per control connection, so the only way to
 * move files in parallel is to open more connections.
 *
 * Servers cap how many they accept, and some ban clients that keep asking, so
 * the pool grows one connection at a time, only while something is waiting,
 * and stops growing for good at the first refusal. Callers never see that:
 * they just wait a bit longer for a connection to free up.
 */
export default class ConnectionPool<T> {
  private _slots: Slot<T>[] = [];
  private _waiting: Waiter<T>[] = [];
  private _limit: number;
  private _connect: () => Promise<T>;
  private _disconnect: (client: T) => void;
  private _connecting: number = 0;
  private _canGrow: boolean;
  private _ended: boolean = false;
  // Owned by the file system, which connects and ends it. The pool borrows it.
  private _primary: T;

  constructor(
    primary: T,
    option: {
      limit: number;
      connect: () => Promise<T>;
      disconnect: (client: T) => void;
    }
  ) {
    this._limit = Math.max(1, option.limit);
    this._connect = option.connect;
    this._disconnect = option.disconnect;
    this._canGrow = this._limit > 1;
    this._primary = primary;
    this._slots.push({ client: primary, busy: false, broken: false });
  }

  get size(): number {
    return this._slots.length;
  }

  async acquire(): Promise<PooledConnection<T>> {
    if (this._ended) {
      throw new Error('The connection pool has been closed.');
    }

    const idle = this._idleSlot();
    if (idle) {
      idle.busy = true;
      return this._lease(idle);
    }

    const slot = await new Promise<Slot<T>>((resolve, reject) => {
      this._waiting.push({ resolve, reject });
      // Not `_grow` directly: dispatching also fails the caller outright when
      // there is nothing left to wait for.
      this._dispatch();
    });

    return this._lease(slot);
  }

  release(lease: PooledConnection<T>): void {
    const slot = this._slots.find(s => s.client === lease.client);
    if (!slot) {
      return;
    }

    slot.busy = false;
    if (slot.broken) {
      this._drop(slot);
    }

    this._dispatch();
  }

  /**
   * Retire a connection the transport says is gone. Without this a half-open
   * connection would be handed out again and the command on it would wait for
   * a reply that can't arrive.
   */
  discard(client: T): void {
    const slot = this._slots.find(s => s.client === client);
    if (!slot) {
      return;
    }

    slot.broken = true;
    if (!slot.busy) {
      this._drop(slot);
    }

    this._dispatch();
  }

  end(): void {
    this._ended = true;

    const waiting = this._waiting;
    this._waiting = [];
    waiting.forEach(w => w.reject(new Error('The connection pool has been closed.')));

    const slots = this._slots;
    this._slots = [];
    slots.forEach(s => this._close(s.client));
  }

  private _lease(slot: Slot<T>): PooledConnection<T> {
    return {
      client: slot.client,
      invalidate: () => {
        slot.broken = true;
      },
    };
  }

  private _idleSlot(): Slot<T> | undefined {
    return this._slots.find(s => !s.busy && !s.broken);
  }

  private _dispatch(): void {
    while (this._waiting.length > 0) {
      const idle = this._idleSlot();
      if (!idle) {
        break;
      }

      idle.busy = true;
      this._waiting.shift()!.resolve(idle);
    }

    if (this._waiting.length === 0) {
      return;
    }

    // Nothing usable is left and nothing is on its way, so waiting would hang.
    if (this._slots.length === 0 && this._connecting === 0 && !this._canGrow) {
      this.end();
      return;
    }

    this._grow();
  }

  private _drop(slot: Slot<T>): void {
    const index = this._slots.indexOf(slot);
    if (index === -1) {
      return;
    }

    this._slots.splice(index, 1);
    this._close(slot.client);
  }

  private _close(client: T): void {
    // The file system ends the primary connection itself.
    if (client === this._primary) {
      return;
    }

    this._disconnect(client);
  }

  /**
   * Fire-and-forget: a connection that arrives is handed to a waiter, and one
   * that never arrives just leaves the waiters queued behind the connections
   * that are already open.
   */
  private _grow(): void {
    if (
      this._ended ||
      !this._canGrow ||
      this._slots.length + this._connecting >= this._limit
    ) {
      return;
    }

    this._connecting += 1;
    this._connect().then(
      client => {
        this._connecting -= 1;
        if (this._ended) {
          this._close(client);
          return;
        }

        this._slots.push({ client, busy: false, broken: false });
        this._dispatch();
      },
      error => {
        this._connecting -= 1;
        // Assume the server won't accept more than it already has.
        this._canGrow = false;
        this._limit = Math.max(1, this._slots.length);
        logger.info(
          `Can't open another FTP connection (${error.message}). ` +
            `Continuing with ${this._limit}.`
        );
        this._dispatch();
      }
    );
  }
}
