/**
 * Deliberately empty of shims.
 *
 * This file used to install `util.isDate` for ssh2, on the reasoning that the
 * editor ran an older Node and only the test process needed it. The editor
 * does not, and the shim here meant no test in this suite could ever fail the
 * way the extension failed: every SFTP file read threw "isDate is not a
 * function" while the tests passed.
 *
 * The extension installs its own, in `src/core/nodeCompat`, at the only moment
 * that works. The suite runs on a bare runtime so that it can say whether that
 * is true.
 */
