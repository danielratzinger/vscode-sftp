/**
 * One of a thing at a time, per key.
 *
 * Written for questions put to somebody. A notification cannot be taken back -
 * `showInformationMessage` hands out no handle to close - so a second question
 * asked while the first is still open does not replace it, it stacks beneath it.
 * Ask a question every minute about a folder that keeps changing and the corner
 * of the screen fills with questions, all but the last of them stale.
 *
 * So the second question is not asked. `hold` runs the work only when nothing is
 * running for that key, and answers `undefined` when something is; whatever the
 * work would have done is left for the next time round, by which point the
 * answer may be a different one anyway. That is the point: a question suppressed
 * is not a question lost, it is one asked later about what is true then.
 */

export interface Gate {
  /**
   * Runs `work` unless this key is already busy, in which case nothing runs and
   * the answer is `undefined`. The key is freed however the work ends.
   */
  hold<T>(key: string, work: () => Promise<T>): Promise<T | undefined>;

  /**
   * Whether this key is busy. For skipping the cost of *preparing* the work as
   * well as the work - there is no point walking a disk to decide on a question
   * that will not be asked.
   */
  holding(key: string): boolean;
}

export function createGate(): Gate {
  const busy = new Set<string>();

  return {
    holding: key => busy.has(key),

    async hold(key, work) {
      if (busy.has(key)) {
        return undefined;
      }

      busy.add(key);
      try {
        return await work();
      } finally {
        busy.delete(key);
      }
    },
  };
}
