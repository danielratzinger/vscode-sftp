import * as path from 'path';

/**
 * Files a save has already put on the server, and the moment each was written.
 *
 * While a connection autosyncs the folder this window has open, a save goes
 * up at once rather than when it has settled - and the watcher sees the same
 * write a moment later and queues it too. Sending it twice is harmless but
 * pointless, so the watcher asks here first.
 *
 * Keyed by modification time as well as path: a file written again after the
 * save went up is new work, and the watcher must send that.
 */
export default class SentOnSave {
  private _sent = new Map<string, number>();

  record(file: string, mtime: number): void {
    this._sent.set(path.resolve(file), mtime);
  }

  /**
   * Whether this exact write has already gone up. Answered once: the record
   * is spent by the question, whichever way it goes.
   */
  alreadySent(file: string, mtime: number): boolean {
    const key = path.resolve(file);
    const sent = this._sent.get(key);
    if (sent === undefined) {
      return false;
    }

    this._sent.delete(key);
    return sent === mtime;
  }
}
