import { Manifest, WalkOption, WalkResult } from './search';

/**
 * The file list a walk produced, kept just long enough to be continued.
 *
 * Paging through a tree is only worth offering if page two is cheaper than
 * page one. Without this, continuing means walking every directory again to
 * reach the files already listed - so an agent asking for the rest pays for
 * what it has seen twice, and a big tree gets more expensive the further it
 * reads.
 *
 * The first page is always walked fresh, so what a listing says is what the
 * server has now; only a continuation is served from here, which is also what
 * makes the pages consistent with each other rather than a mixture of two
 * different moments.
 */

const TTL = 2 * 60 * 1000;
const MAX_ENTRIES = 20;

interface Held {
  result: WalkResult;
  at: number;
}

const held: { [key: string]: Held } = {};

export function keyFor(
  connectionId: string,
  root: string,
  option: WalkOption
): string {
  return [
    connectionId,
    root,
    option.maxDepth,
    option.maxFiles,
    option.excludeFolders.join(','),
  ].join('|');
}

export function remember(
  key: string,
  result: WalkResult,
  now: number = Date.now()
): void {
  held[key] = { result, at: now };

  const keys = Object.keys(held);
  if (keys.length <= MAX_ENTRIES) {
    return;
  }

  // The one nobody has touched for longest; there is no cost to being wrong.
  const oldest = keys.reduce((a, b) => (held[a].at <= held[b].at ? a : b));
  delete held[oldest];
}

export function recall(
  key: string,
  now: number = Date.now()
): WalkResult | undefined {
  const entry = held[key];
  if (!entry) {
    return undefined;
  }

  if (now - entry.at > TTL) {
    delete held[key];
    return undefined;
  }

  return entry.result;
}

export function forget(key?: string): void {
  if (key === undefined) {
    Object.keys(held).forEach(name => delete held[name]);
    return;
  }

  delete held[key];
}

/** Where a page ends, or nothing when there is no more to read. */
export function nextOffset(
  total: number,
  offset: number,
  taken: number
): number | undefined {
  const end = offset + taken;
  return end < total ? end : undefined;
}

/** A page argument from a client, which may be anything at all. */
export function offsetOf(value: any, total: number): number {
  const asNumber = typeof value === 'number' ? value : parseInt(value, 10);

  if (!isFinite(asNumber) || asNumber <= 0) {
    return 0;
  }

  return Math.min(Math.floor(asNumber), total);
}

export { Manifest };
