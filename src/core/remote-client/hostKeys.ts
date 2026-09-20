/**
 * The seam between checking a host key and asking somebody about it.
 *
 * The check has to happen in the middle of `Client.connect`, which lives here
 * in core; the question it sometimes has to ask - trust this, or refuse it -
 * belongs to the editor, which core knows nothing about. So the editor leaves
 * an answer-provider behind and core calls it.
 *
 * With nothing set, nothing is verified, which is what this extension did for
 * its whole life before now. That default matters for the tests and for any
 * path that builds a client without the module layer.
 */

export interface HostKeyOption {
  /** A `known_hosts` this connection's ssh config named. */
  knownHostsPath?: string;
  /** `StrictHostKeyChecking accept-new`: a host not seen before is taken. */
  acceptNew?: boolean;
}

export type HostKeyCheck = (
  host: string,
  port: number,
  key: Buffer,
  option?: HostKeyOption
) => Promise<boolean>;

let check: HostKeyCheck | undefined;

export function setHostKeyCheck(fn: HostKeyCheck | undefined): void {
  check = fn;
}

export function hostKeyCheck(): HostKeyCheck | undefined {
  return check;
}
