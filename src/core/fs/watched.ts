import { withConnection } from '../../logger';

/**
 * A file system that knows which connection it is, and notices it failing.
 *
 * Two jobs, one wrapper, because both need the same thing: a point outside the
 * file system where every call in and every failure out can be seen.
 *
 * The name is what turns `[info] timeout` into `[info:staging] timeout`. It
 * has to be applied here rather than at the lines themselves, because almost
 * all of them are written from inside a client library's callbacks - a socket
 * event with no idea which configuration opened it.
 */
export function watched<T extends object>(
  fs: T,
  option: { name?: string; onTrouble?(error: any): void }
): T {
  // Kept, so that the same method read twice is the same function: a fresh
  // closure per access breaks anything that unsubscribes what it subscribed.
  const wrapped: { [name: string]: any } = Object.create(null);

  return new Proxy(fs, {
    get(target: any, property: PropertyKey) {
      const value = target[property];
      if (typeof value !== 'function' || typeof property !== 'string') {
        return value;
      }
      if (wrapped[property]) {
        return wrapped[property];
      }

      wrapped[property] = (...args: any[]) =>
        withConnection(option.name, () => {
          const answer = value.apply(target, args);

          // Only asynchronous work fails in the way this watches for.
          if (!answer || typeof answer.then !== 'function') {
            return answer;
          }

          return answer.then(undefined, (error: any) => {
            if (option.onTrouble) {
              option.onTrouble(error);
            }
            throw error;
          });
        });

      return wrapped[property];
    },
  }) as T;
}
