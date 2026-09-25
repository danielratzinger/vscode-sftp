import * as fs from 'fs';
import * as path from 'path';
import logger from '../../logger';

/**
 * A tenth of what is coming, kept free.
 *
 * Landing a folder exactly into the last free byte leaves a machine with no
 * room to save a file, and the editor and everything else on it need some.
 */
const KEEP_FREE = 0.1;

/** The nearest folder above this one that exists, since a new one has no size. */
function nearestExisting(where: string): string | null {
  let at = path.resolve(where);

  for (;;) {
    if (fs.existsSync(at)) {
      return at;
    }

    const up = path.dirname(at);
    if (up === at) {
      return null;
    }
    at = up;
  }
}

/**
 * How many bytes this machine has left where that path is, or undefined when it
 * will not say - which is not the same as saying there is none.
 */
export function freeBytesAt(where: string): Promise<number | undefined> {
  return new Promise(resolve => {
    const at = nearestExisting(where);
    const statfs = (fs as any).statfs;

    if (!at || typeof statfs !== 'function') {
      resolve(undefined);
      return;
    }

    statfs(at, (error: Error, stats: any) => {
      if (error || !stats) {
        resolve(undefined);
        return;
      }

      resolve(stats.bavail * stats.bsize);
    });
  });
}

export interface Room {
  fits: boolean;
  /** What it would say to somebody, when it does not. */
  because?: string;
}

/**
 * Whether what is coming will fit where it is going.
 *
 * Asked before a folder is fetched rather than found out in the middle of it: a
 * transfer that runs out of room leaves a folder of half-written files and a
 * machine with nothing left, and neither of those is something to discover one
 * file at a time.
 *
 * Anything unknown is a yes. Refusing a transfer because a question could not be
 * answered would be worse than the thing it guards against.
 */
export async function roomFor(
  bytes: number | undefined,
  where: string,
  howMuchIsFree: (at: string) => Promise<number | undefined> = freeBytesAt
): Promise<Room> {
  if (bytes === undefined || !(bytes > 0)) {
    return { fits: true };
  }

  const free = await howMuchIsFree(where);
  if (free === undefined) {
    logger.debug(`[archive] cannot tell how much room is left at ${where}`);
    return { fits: true };
  }

  const wanted = bytes * (1 + KEEP_FREE);
  if (free >= wanted) {
    return { fits: true };
  }

  return {
    fits: false,
    because:
      `it needs about ${Math.round(bytes / (1024 * 1024))} MB and this ` +
      `machine has ${Math.round(free / (1024 * 1024))} MB left`,
  };
}
