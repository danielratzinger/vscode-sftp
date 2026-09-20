/**
 * Keeping ssh2 working on the Node the editor actually runs.
 *
 * `util.isDate` was deprecated for years and removed in Node 23. ssh2 1.13
 * destructures it at load time and calls it whenever it encodes file
 * attributes - which every `open` and every `fastGet` does - so on a newer
 * runtime every SFTP file read fails with "isDate is not a function" while
 * directory listings, which encode no attributes, carry on working.
 *
 * VS Code ships its own Node: 24.18.1 at the time of writing, where the
 * function is gone. Upgrading ssh2 is the real fix and is not a small change;
 * until then this restores the three lines of behaviour the library expects,
 * and only if the runtime does not have them.
 */
export function installNodeCompat(): void {
  // tslint:disable-next-line:no-var-requires
  const util = require('util');

  if (typeof util.isDate !== 'function') {
    util.isDate = (value: any) =>
      value instanceof Date ||
      Object.prototype.toString.call(value) === '[object Date]';
  }
}
