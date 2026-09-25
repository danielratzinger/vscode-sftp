import logger from '../../logger';

/** How often an archive says where it has got to. */
export const PROGRESS_EVERY = 3000;

/**
 * Says something every so often, and never more often than that.
 *
 * An archive is one operation that runs for as long as the whole transfer, so
 * without this the log holds a line saying it started and then nothing until it
 * is over - which for a large folder is minutes of no way to tell a slow
 * transfer from a stuck one. Not at debug level, because that is exactly the
 * question somebody asks without having turned debug on.
 */
export function occasionally(
  every: number = PROGRESS_EVERY
): (say: () => string) => void {
  // From now, so the first line is progress and not a restatement of the line
  // above it.
  let last = Date.now();

  return say => {
    if (!(every > 0)) {
      return;
    }

    const now = Date.now();
    if (now - last < every) {
      return;
    }

    last = now;
    logger.info(say());
  };
}
