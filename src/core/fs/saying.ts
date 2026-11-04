/**
 * An SFTP error, made to say what was being done and to which file.
 *
 * The server's answer alone is a word - "Failure", "Permission denied" - and
 * in the middle of a folder of four thousand files that word is all the log
 * had: no path, no operation, nothing to go and look at. The code is kept, and
 * the original words stay at the front, so whatever reads either still does.
 *
 * Status 4 is SFTP's "something went wrong" - the server not saying what. It
 * is said so, with what it usually is, rather than left looking like an
 * explanation.
 */

const SAID = Symbol('said');

export default function saying<T>(error: T, what: string): T {
  const e: any = error;
  if (!e || typeof e !== 'object' || e[SAID] || typeof e.message !== 'string') {
    return error;
  }
  Object.defineProperty(e, SAID, { value: true });

  const before = e.message;
  const unexplained = e.code === 4 && /^failure$/i.test(before.trim());
  e.message =
    `${before}: could not ${what}` +
    (unexplained
      ? ' (the server gave no reason - often a full disk or quota, a file it cannot read, or a name it will not take)'
      : '');

  // The log prints the stack, whose first line is the message as it was when
  // the stack was first read - which may be before this, or not yet.
  if (typeof e.stack === 'string') {
    const name = e.name || 'Error';
    const now = `${name}: ${e.message}`;
    const then = `${name}: ${before}`;
    if (e.stack.indexOf(now) !== 0 && e.stack.indexOf(then) === 0) {
      e.stack = now + e.stack.slice(then.length);
    }
  }
  return error;
}
