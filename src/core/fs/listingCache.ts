/**
 * Directory listings, remembered for a moment.
 *
 * Over FTP a listing is a data connection of its own - over FTPS with its own
 * TLS handshake - and asking whether one file exists means listing the whole
 * folder it is in. Autosync asks that for every file before keeping the
 * server's copy, so a batch of six files in one folder listed it six times in
 * the same second, to get the same answer six times.
 *
 * So a listing is kept for a few seconds, and so is "this folder is not
 * there" - on an empty server that is the answer for every folder. Two asking
 * at once share one listing. Anything written through this file system forgets
 * the folders it touched straight away, and a listing that was in flight when
 * something was written is not kept, since it may have been taken before.
 * What other programs write is noticed when the few seconds are up.
 */

export const LISTING_TRUSTED_FOR = 3000;

interface Known<T> {
  at: number;
  entries?: T[];
  missing?: any;
}

export default class ListingCache<T> {
  private _known = new Map<string, Known<T>>();
  private _pending = new Map<string, Promise<T[]>>();
  private _generation = 0;

  constructor(
    private _isMissing: (error: any) => boolean,
    private _now: () => number = Date.now,
    private _trustedFor = LISTING_TRUSTED_FOR
  ) {}

  async list(dir: string, read: () => Promise<T[]>): Promise<T[]> {
    const key = normal(dir);
    const known = this._known.get(key);
    if (known && this._now() - known.at < this._trustedFor) {
      if (known.missing) {
        throw known.missing;
      }
      return known.entries!.slice();
    }

    const pending = this._pending.get(key);
    if (pending) {
      return (await pending).slice();
    }

    const generation = this._generation;
    const reading = read();
    this._pending.set(key, reading);
    try {
      const entries = await reading;
      if (generation === this._generation) {
        this._known.set(key, { at: this._now(), entries });
      }
      return entries.slice();
    } catch (error) {
      if (generation === this._generation && this._isMissing(error)) {
        this._known.set(key, { at: this._now(), missing: error });
      }
      throw error;
    } finally {
      this._pending.delete(key);
    }
  }

  /**
   * Something at `path` was written, created, removed or renamed: the folder it
   * is in lists differently now, and if it is a folder, so does everything
   * that was remembered as not being under it.
   */
  forget(path: string): void {
    this._generation += 1;
    const key = normal(path);
    const parent = parentOf(key);
    Array.from(this._known.keys()).forEach(one => {
      if (one === key || one === parent || one.indexOf(`${key}/`) === 0) {
        this._known.delete(one);
      }
    });
  }

  clear(): void {
    this._generation += 1;
    this._known.clear();
  }
}

function normal(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '/' : path.slice(0, at);
}
