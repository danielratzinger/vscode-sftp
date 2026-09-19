/**
 * Nothing may sit silent forever.
 *
 * Both protocols can leave an operation outstanding indefinitely: a control
 * connection whose reply never arrives, a data connection that stops mid-file.
 * The socket is open, the peer answers keepalives, and the call simply never
 * returns. Everything above it waits - a transfer, the explorer, or an agent's
 * tool call, which waits with no way to ask what is happening.
 *
 * Two different questions, so two different clocks:
 *
 * - A **command** (list, stat, rename) is a question with one answer, and a
 *   deadline is the right shape: it should have answered by now.
 * - A **transfer** has no deadline that is correct. A large file on a slow line
 *   legitimately takes as long as it takes, and a total time limit would abort
 *   exactly the transfers that need the patience. What is never legitimate is
 *   *no progress at all*, so transfers are watched for silence instead, with
 *   the clock reset by every byte that moves.
 *
 * Neither clock decides that anything succeeded. A timeout is an error, it
 * reads as transient, and the layer above retries it against a fresh
 * connection with the verification it always does. The guarantee that a file
 * arrives whole is unchanged; what changes is that a stall now ends.
 */

export const DEFAULT_OPERATION_TIMEOUT = 60 * 1000;

export class OperationTimeoutError extends Error {
  readonly operation: string;
  /** True when it began and stopped; false when it never answered at all. */
  readonly stalled: boolean;

  constructor(operation: string, ms: number, stalled: boolean) {
    super(
      stalled
        ? `${operation} stopped making progress for ${Math.round(ms / 1000)}s ` +
          'and was abandoned.'
        : `${operation} did not answer within ${Math.round(ms / 1000)}s ` +
          'and was abandoned.'
    );

    this.name = 'OperationTimeoutError';
    this.operation = operation;
    this.stalled = stalled;
    // The prototype chain is lost when a built-in is extended down-level.
    Object.setPrototypeOf(this, OperationTimeoutError.prototype);
  }
}

export function isOperationTimeout(error: any): boolean {
  return Boolean(error) && error.name === 'OperationTimeoutError';
}

export interface DeadlineOption {
  ms: number;
  /** Named in the error, so a log says which call gave up. */
  operation: string;
  /** Run when the deadline passes, before the caller is told. */
  onExpire?(): void;
}

/**
 * Gives up waiting for `work`, and lets the caller retire whatever it was
 * waiting on.
 *
 * The work itself cannot be cancelled - neither protocol has a way to recall a
 * command - so it is abandoned rather than stopped, and its late rejection is
 * swallowed: it belongs to a call that has already been answered, and an
 * unhandled rejection would take down the extension host.
 */
export function withDeadline<T>(
  work: Promise<T>,
  option: DeadlineOption
): Promise<T> {
  if (!(option.ms > 0)) {
    return work;
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;

      // Late rejections are nobody's to handle any more.
      work.catch(() => undefined);

      if (option.onExpire) {
        try {
          option.onExpire();
        } catch (error) {
          // Retiring a connection must not replace the timeout as the reason.
        }
      }

      reject(new OperationTimeoutError(option.operation, option.ms, false));
    }, option.ms);

    // Nothing here should keep the process alive on its own.
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

export interface Watchdog {
  /** Called whenever bytes move. Restarts the clock. */
  progress(): void;
  stop(): void;
}

/**
 * Watches a transfer for silence rather than for length.
 *
 * `onStall` is called at most once, and only if nothing reported progress for
 * the whole interval. A transfer that is merely slow keeps resetting it.
 */
export function watchForStall(
  ms: number,
  operation: string,
  onStall: (error: OperationTimeoutError) => void
): Watchdog {
  if (!(ms > 0)) {
    return { progress: () => undefined, stop: () => undefined };
  }

  let timer: NodeJS.Timer | null = null;
  let done = false;

  const arm = () => {
    timer = setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      onStall(new OperationTimeoutError(operation, ms, true));
    }, ms);

    if (typeof (timer as any).unref === 'function') {
      (timer as any).unref();
    }
  };

  const disarm = () => {
    if (timer) {
      clearTimeout(timer as any);
      timer = null;
    }
  };

  arm();

  return {
    progress: () => {
      if (done) {
        return;
      }
      disarm();
      arm();
    },
    stop: () => {
      done = true;
      disarm();
    },
  };
}

/**
 * Watches a transfer by reading a byte counter it already keeps.
 *
 * Attaching a `data` listener to find out whether bytes are moving would put
 * the stream into flowing mode before its real consumer has piped it, and the
 * bytes emitted in between would be gone: a corrupted file, caused by the
 * thing meant to protect it. Node's file streams and sockets already count
 * what they have read, so this reads that instead and touches nothing.
 *
 * If there is no counter to read, there is no watchdog. A transfer whose
 * progress cannot be measured is left alone rather than abandoned on a guess.
 */
export function watchCounter(
  read: () => number | undefined,
  ms: number,
  operation: string,
  onStall: (error: OperationTimeoutError) => void
): Watchdog {
  const idle = { progress: () => undefined, stop: () => undefined };

  if (!(ms > 0) || typeof read() !== 'number') {
    return idle;
  }

  const watchdog = watchForStall(ms, operation, onStall);
  let last = read();

  // Often enough to notice, rarely enough to cost nothing.
  const every = Math.max(1000, Math.floor(ms / 4));
  const poll = setInterval(() => {
    const now = read();
    if (typeof now !== 'number' || now === last) {
      return;
    }

    last = now;
    watchdog.progress();
  }, every);

  if (typeof (poll as any).unref === 'function') {
    (poll as any).unref();
  }

  return {
    progress: () => watchdog.progress(),
    stop: () => {
      clearInterval(poll as any);
      watchdog.stop();
    },
  };
}
