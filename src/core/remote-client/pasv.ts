/**
 * Which host to open an FTP data connection to.
 *
 * `PASV` answers with an address and a port, and a server behind NAT commonly
 * answers with the address it knows itself by - a private one, unreachable from
 * anywhere but its own network. The client is expected to notice and use the
 * address it reached the server on instead; every mature FTP client does, under
 * one name or another (`--ftp-skip-pasv-ip` in curl).
 *
 * `node-ftp` does eventually get there, but only after the connection to the
 * advertised address times out - `pasvTimeout`, ten seconds by default. Every
 * listing and every file pays it, because nothing about the failure is
 * remembered. A walk of forty directories spends six and a half minutes waiting
 * for an address that was never going to answer.
 *
 * So the question is asked before the attempt rather than after it. Only where
 * the answer is certain: an address that cannot be what we just reached takes
 * the address that we did, and anything else is believed. The timeout stays
 * behind it as the fallback it was meant to be.
 */

/** Ranges no host on the far side of the internet can be reached at. */
const UNROUTABLE: Array<[number, number, number]> = [
  // [first octet, second octet mask, second octet value] - enough for these.
  [10, 0, 0], // 10/8, private
  [127, 0, 0], // 127/8, loopback
];

function octets(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return undefined;
  }

  const numbers = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return numbers.some(n => !(n >= 0 && n <= 255)) ? undefined : numbers;
}

/**
 * Whether an address is one that only its own network can reach. IPv4 only:
 * `PASV` cannot express anything else, and a server speaking IPv6 uses `EPSV`.
 */
export function isUnroutable(address: string): boolean {
  const parts = octets(address);
  if (!parts) {
    return false;
  }

  const [a, b] = parts;

  if (UNROUTABLE.some(([first]) => a === first)) {
    return true;
  }
  if (a === 0) {
    // Some servers mean "the address you already have" by this.
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 169 && b === 254) {
    // Link-local: the address of a host that never got one.
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    // Carrier NAT. Reachable from inside that carrier and nowhere else, which
    // from here is the same as nowhere.
    return true;
  }

  return false;
}

/**
 * The host to connect to, given what the server advertised and the address the
 * control connection is actually talking to.
 *
 * The advertised address is believed unless it cannot be right. Two addresses on
 * the same private network can both be right - a server on the LAN advertising
 * its LAN address is telling the truth - so the substitution needs the control
 * connection to be somewhere the advertised address could not have come from.
 */
export function dataHost(advertised: string, control?: string): string {
  if (!control || advertised === control) {
    return advertised;
  }
  if (!isUnroutable(advertised)) {
    return advertised;
  }
  if (isUnroutable(control)) {
    // Both private: we are on its network, so what it said may well be right.
    return advertised;
  }

  return control;
}
