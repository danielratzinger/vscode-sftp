/**
 * What makes two configurations the same connection.
 *
 * Reaching a server is all that counts: the protocol, the host, the port, the
 * login. Two entries in `sftp.json` that arrive at the same place over the same
 * credentials share one socket, and always have - which is why `getHostInfo`
 * strips `name` and `remotePath` before anything gets this far.
 *
 * `connectionName` gets past that, though, because it is carried on the same
 * object: a credential is keyed per project, so the resolver needs to know
 * which project this is. It is not part of reaching the server and must not be
 * part of the identity. When it was, every entry on one login opened a socket
 * of its own, each with its own thirty-second keepalive - and worse, the
 * disposal path computes the identity *without* it, so nothing was ever found
 * to be ended. Saving `sftp.json` leaked a connection every time.
 */

/** Carried on the option, but nothing to do with which server this is. */
const NOT_THE_SERVER = ['connectionName'];

/**
 * A stable identity for a connection option.
 *
 * By key and value rather than the values run together: `{a: 'x', b: 'yz'}` and
 * `{a: 'xy', b: 'z'}` are not the same connection, and joining values alone
 * said they were. Sorted, so two objects built in a different order still agree.
 */
export function identityOf(option: { [key: string]: any }): string {
  return Object.keys(option)
    .filter(key => NOT_THE_SERVER.indexOf(key) === -1)
    .filter(key => option[key] !== undefined)
    .sort()
    .map(key => `${key}=${String(option[key])}`)
    .join('\n');
}
