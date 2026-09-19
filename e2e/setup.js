/**
 * `util.isDate` was deprecated for years and removed in Node 23. ssh2 1.13
 * still calls it whenever it encodes file attributes, so on a modern Node the
 * library throws before it can send a STAT reply or a SETSTAT.
 *
 * VS Code bundles its own, older Node, so the extension is unaffected in the
 * editor - but this suite runs on the system one. The shim is restricted to
 * the test process: it must never become a reason for the extension to depend
 * on a patched runtime.
 */
const util = require('util');

if (typeof util.isDate !== 'function') {
  util.isDate = value =>
    value instanceof Date ||
    Object.prototype.toString.call(value) === '[object Date]';
}
