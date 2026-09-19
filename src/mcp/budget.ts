/**
 * A ceiling on one tool call.
 *
 * Every *operation* is bounded by `operationTimeout`, but a call is not one
 * operation: a search walks directories and reads files, each within its own
 * deadline, and the worst case is many bounded operations in a row. A client
 * waiting on that has no way to ask how it is going, and a model has no way to
 * learn that the question was too broad.
 *
 * So a call gets a budget, spent two ways:
 *
 * - The tools that loop check it between round trips and stop early, returning
 *   what they found and saying it was cut short. Partial results answer the
 *   question better than an error does.
 *   answers the question better than an error does.
 * - Whatever does not check it is stopped anyway, by the dispatcher, so no
 *   call can run past the budget however it was written.
 */

export interface Budget {
  /** True once there is no time left. Checked between round trips. */
  spent(): boolean;
  remaining(): number;
}

/** A budget that never runs out, for calls that are not worth bounding. */
export const UNLIMITED: Budget = {
  spent: () => false,
  remaining: () => Infinity,
};

export function createBudget(ms: number, now: () => number = Date.now): Budget {
  if (!(ms > 0)) {
    return UNLIMITED;
  }

  const until = now() + ms;

  return {
    spent: () => now() >= until,
    remaining: () => Math.max(0, until - now()),
  };
}

export class CallTimeoutError extends Error {
  constructor(name: string, ms: number) {
    super(
      `${name} ran past its ${Math.round(ms / 1000)}s budget and was stopped. ` +
        'Ask for less: a single directory rather than a whole tree, a narrower ' +
        'search, or one file at a time.'
    );

    this.name = 'CallTimeoutError';
    Object.setPrototypeOf(this, CallTimeoutError.prototype);
  }
}

/**
 * The backstop. The work carries on until whatever it is waiting for gives up
 * - nothing here can cancel a round trip already in flight - but the caller is
 * answered on time, and its late failure is swallowed rather than surfacing as
 * an unhandled rejection.
 */
export function withBudget<T>(
  work: Promise<T>,
  ms: number,
  name: string
): Promise<T> {
  if (!(ms > 0)) {
    return work;
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      work.catch(() => undefined);
      reject(new CallTimeoutError(name, ms));
    }, ms);

    if (typeof (timer as any).unref === 'function') {
      (timer as any).unref();
    }

    work.then(
      value => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
