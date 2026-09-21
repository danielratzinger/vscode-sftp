/**
 * The seam between checking a host key and asking somebody about it.
 *
 * The check happens in the middle of `Client.connect`, which lives here in
 * core; the question it sometimes has to ask - trust this, or refuse it -
 * belongs to the editor, which core knows nothing about. So the editor leaves
 * a checker behind and core calls it.
 *
 * **The decision has to be synchronous, and this shape exists to make that
 * possible.** ssh2 advertises `ext-info-c`, so an OpenSSH server sends
 * `EXT_INFO` the instant it sends `NEWKEYS`, encrypted under the new keys. If
 * the host verifier has not answered by then, ssh2 defers switching the
 * decipher and that packet is decrypted with the old one - which produces
 * `Bad packet length` and a dead connection. Anything awaited inside the
 * verifier, even reading a file that is already in the page cache, is long
 * enough for that to happen.
 *
 * So the work is split in three. `prepare` does the reading, before the socket
 * is opened and with all the time in the world. `decide` is a comparison
 * against what `prepare` loaded, and returns a boolean there and then.
 * `askAgain` handles a refusal afterwards, out of the handshake entirely,
 * where a dialog costs nothing.
 *
 * With nothing set, nothing is verified, which is what this extension did for
 * its whole life before this. That default matters for the tests and for any
 * path that builds a client without the module layer.
 */

export interface HostKeyOption {
  /** A `known_hosts` this connection's ssh config named. */
  knownHostsPath?: string;
  /** `StrictHostKeyChecking accept-new`: a host not seen before is taken. */
  acceptNew?: boolean;
}

export interface HostKeyChecker {
  /** Reads what is on record for this host. Before the socket is opened. */
  prepare(host: string, port: number, option?: HostKeyOption): Promise<void>;
  /** The answer, without waiting for anything. */
  decide(host: string, port: number, key: Buffer): boolean;
  /**
   * After a refusal: put the question to somebody, and say whether the
   * connection is worth trying again.
   */
  askAgain(host: string, port: number, option?: HostKeyOption): Promise<boolean>;
}

let checker: HostKeyChecker | undefined;

export function setHostKeyChecker(one: HostKeyChecker | undefined): void {
  checker = one;
}

export function hostKeyChecker(): HostKeyChecker | undefined {
  return checker;
}
