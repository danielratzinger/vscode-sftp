import { FileType } from './fileSystem';

/**
 * One file's facts, from `MLST` (RFC 3659).
 *
 * The question "what is this file" answered on the connection already open,
 * rather than by listing its whole folder over a new data connection - one
 * line in place of a TLS handshake, over FTPS.
 *
 * The reply's facts sit on the line that begins with a space:
 * ` type=file;size=1234;modify=20261022043327; /site/wwwroot/a.php`.
 * `modify` is UTC by the RFC, which is why it is read with Date.UTC and needs
 * none of the offset a LIST listing's wall-clock time does.
 */
export interface MlstFacts {
  type: FileType;
  size: number;
  mtime: number;
  mode?: number;
}

export function parseMlst(text: string): MlstFacts | undefined {
  const line = text
    .split(/\r?\n/)
    .map(one => one.replace(/^\s+/, ''))
    .find(one => /^[a-z.]+=[^;]*;/i.test(one));
  if (!line) {
    return undefined;
  }

  const facts: { [name: string]: string } = {};
  const space = line.indexOf('; ');
  (space === -1 ? line : line.slice(0, space + 1))
    .split(';')
    .filter(Boolean)
    .forEach(fact => {
      const eq = fact.indexOf('=');
      if (eq > 0) {
        facts[fact.slice(0, eq).toLowerCase()] = fact.slice(eq + 1);
      }
    });

  const type = (facts.type || '').toLowerCase();
  const mtime = utcOf(facts.modify);
  const mode = facts['unix.mode'] ? parseInt(facts['unix.mode'], 8) : undefined;

  return {
    type:
      type === 'dir' || type === 'cdir' || type === 'pdir'
        ? FileType.Directory
        : /symlink|slink/.test(type)
        ? FileType.SymbolicLink
        : FileType.File,
    size: facts.size !== undefined ? parseInt(facts.size, 10) || 0 : 0,
    mtime,
    mode: mode !== undefined && !isNaN(mode) ? mode : undefined,
  };
}

function utcOf(stamp: string | undefined): number {
  const parts = stamp && stamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/);
  if (!parts) {
    return 0;
  }
  const [, y, mo, d, h, mi, s, frac] = parts;
  const ms = frac ? Math.round(parseFloat(`0.${frac}`) * 1000) : 0;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms);
}

/** Whether the server said, in FEAT, that it answers MLST. */
export function offersMlst(feat: string[] | undefined): boolean {
  return Array.isArray(feat) && feat.some(one => /^MLST\b/i.test(String(one).trim()));
}
