/**
 * What is waiting to go to the server, and when it may go.
 *
 * One structure for three things that were separate and shouldn't have been:
 *
 * **Settling.** A file must sit still before it is uploaded, because a build
 * step writes a hundred files in a second and a tool that writes without an
 * atomic rename leaves a half-written one visible in between. Writing to a
 * file that is already waiting pushes its moment back.
 *
 * **Retrying.** An upload that fails was, until now, logged and forgotten -
 * so a connection that blinked for thirty seconds while an agent worked left
 * those changes on this machine only, and nothing said so. A failure now goes
 * back in the queue behind a cooldown that grows as attempts pile up, so a
 * server that is briefly refusing is waited out and one that is truly gone is
 * not hammered.
 *
 * **Remembering.** The queue is plain data so it can be written down. Closing
 * the window with work outstanding no longer discards it; it is picked up
 * when the window comes back.
 *
 * Deliberately not a class with a timer in it: what is due is a function of
 * the clock, which makes every rule here answerable in a test without waiting
 * for anything.
 */

export type Operation = 'upload' | 'remove';

export interface QueuedOp {
  file: string;
  op: Operation;
  /** The earliest moment this may be attempted. */
  at: number;
  /** How many attempts have failed. */
  tries: number;
}

export interface QueueOption {
  /** How long a file must sit still before it is sent. */
  settle: number;
  /** How long to wait after a failure before trying again. */
  cooldown: number;
  /** The most the cooldown may grow to, however many attempts fail. */
  maxCooldown?: number;
}

const MAX_COOLDOWN = 5 * 60 * 1000;

export default class SyncQueue {
  private _waiting = new Map<string, QueuedOp>();
  private _option: QueueOption;

  constructor(option: QueueOption, held: QueuedOp[] = []) {
    this._option = option;
    held.forEach(one => this._waiting.set(one.file, { ...one }));
  }

  get size(): number {
    return this._waiting.size;
  }

  /** Everything outstanding, oldest first, for saying what is waiting. */
  all(): QueuedOp[] {
    return Array.from(this._waiting.values()).sort((a, b) => a.at - b.at);
  }

  /**
   * A file changed.
   *
   * The latest thing that happened to a file is the only thing that matters:
   * writing it twice is one upload, and deleting something that was waiting to
   * be uploaded is a delete. Attempts already made are dropped with the old
   * operation - this is new work, not a continuation of what failed.
   */
  put(file: string, op: Operation, now: number): void {
    this._waiting.set(file, { file, op, at: now + this._option.settle, tries: 0 });
  }

  /** Whatever was waiting for this file is no longer wanted. */
  drop(file: string): void {
    this._waiting.delete(file);
  }

  /** What may be attempted now, in the order it arrived. */
  due(now: number): QueuedOp[] {
    return this.all().filter(one => one.at <= now);
  }

  /** Whether anything is waiting only because it failed before. */
  retrying(): QueuedOp[] {
    return this.all().filter(one => one.tries > 0);
  }

  done(file: string): void {
    this._waiting.delete(file);
  }

  /**
   * An attempt failed, so it waits longer before the next one.
   *
   * Backed off in proportion to the attempts made, and capped: a file whose
   * upload cannot succeed - no permission on the server, say - settles into
   * one attempt every few minutes rather than filling the log.
   *
   * Does nothing if the file changed again while the attempt was in flight;
   * that newer write has its own place in the queue and is not to be pushed
   * back behind this failure.
   */
  failed(file: string, now: number, expected?: QueuedOp): void {
    const held = this._waiting.get(file);
    if (!held) {
      return;
    }
    if (expected && held.at !== expected.at) {
      return;
    }

    const tries = held.tries + 1;
    const cap = this._option.maxCooldown || MAX_COOLDOWN;
    const wait = Math.min(this._option.cooldown * tries, cap);

    this._waiting.set(file, { ...held, tries, at: now + wait });
  }

  /** Plain data, for writing down. */
  toJSON(): QueuedOp[] {
    return this.all();
  }
}

/**
 * A queue read back from storage.
 *
 * Everything in it is due at once: whatever it was waiting for happened while
 * the window was closed, and a cooldown measured against a clock from last
 * week means nothing.
 */
export function resumed(option: QueueOption, held: QueuedOp[], now: number): SyncQueue {
  return new SyncQueue(
    option,
    held
      .filter(
        one =>
          one &&
          typeof one.file === 'string' &&
          (one.op === 'upload' || one.op === 'remove')
      )
      .map(one => ({ ...one, at: now, tries: one.tries || 0 }))
  );
}
