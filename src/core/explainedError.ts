/**
 * Errors whose message is the whole story.
 *
 * A stack trace says where in this extension something went wrong, which is
 * what a bug needs and what a server that will not answer does not: the
 * trace of a refused connection is the same eight lines of socket plumbing
 * every time, and pushes the one line that says what happened out of view.
 * Errors marked here are logged as their message alone, unless the trace is
 * asked for - `sftp.debug` is the switch for wanting everything. Everything
 * else keeps its trace.
 */

const EXPLAINED = Symbol('explained');

export function markExplained<T>(error: T): T {
  if (error && typeof error === 'object') {
    Object.defineProperty(error, EXPLAINED, { value: true });
  }
  return error;
}

export function isExplained(error: any): boolean {
  return Boolean(error && error[EXPLAINED]);
}

/** How an error is written to the log. */
export function forLog(error: Error, withTrace = false): string {
  return isExplained(error) && !withTrace
    ? error.message
    : String(error.stack || error.message);
}
