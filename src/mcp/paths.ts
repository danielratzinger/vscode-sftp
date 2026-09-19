import upath from '../core/upath';

/**
 * The boundary of a connection.
 *
 * Every tool takes a path from the client, and a path is the one argument that
 * decides both what is read from the server and where it is written on this
 * machine. Left unchecked, `../../..` walks out of the exposed directory in
 * both directions at once: it reads a part of the server nobody chose to
 * expose, and it materialises the result outside the project folder, anywhere
 * the user can write. `sftp.mcp.exposed` and the per-connection `mcp.exposed`
 * are how someone says what an agent may see; without this they only choose
 * where it starts looking.
 *
 * So every path is resolved against the connection's `remotePath` and refused
 * if it lands outside. Resolution is canonical - `.`, `..`, doubled and
 * trailing slashes are gone - which also means one file has one cache path and
 * one note key however it was spelled.
 */

/** Posix, absolute, no `.`/`..`, no trailing slash. Root stays `/`. */
export function normaliseRemote(candidate: string): string {
  const normalised = upath.normalize(String(candidate).trim());
  const trimmed = normalised.replace(/\/+$/, '');

  // `upath.normalize('')` is `.`, which is not a remote path.
  return trimmed === '' || trimmed === '.' ? '/' : trimmed;
}

/**
 * The canonical form of `candidate` if it is inside `root`, otherwise nothing.
 *
 * A relative path is taken as relative to the root, which is how a model
 * usually means it.
 */
export function resolveWithin(
  root: string,
  candidate: string
): string | undefined {
  const base = normaliseRemote(root);
  const raw = String(candidate).trim();

  if (raw === '') {
    return undefined;
  }

  const absolute = raw.charAt(0) === '/' ? raw : upath.join(base, raw);
  const resolved = normaliseRemote(absolute);

  if (base === '/') {
    // A connection rooted at `/` exposes the whole server, which is a choice
    // its own configuration made.
    return resolved;
  }

  // `/srv/appendix` must not pass as inside `/srv/app`.
  return resolved === base || resolved.indexOf(`${base}/`) === 0
    ? resolved
    : undefined;
}

/**
 * Says no without saying whether the path exists: the answer is the same for
 * a real file and an imagined one, so this cannot be used to map the server.
 */
export function outsideMessage(root: string, candidate: string): string {
  return (
    `${candidate} is outside ${normaliseRemote(root)}, which is what this ` +
    'connection exposes. Ask about paths below it.'
  );
}
