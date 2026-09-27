/**
 * Permissions as the three or four octal digits everybody writes them as.
 *
 * On its own here, with nothing imported, so the rules can be tested without an
 * editor around them.
 */

/** The digits of a mode, without the file-type bits a stat carries with them. */
export function formatMode(mode: number): string {
  // tslint:disable-next-line:no-bitwise
  return (mode & 0o7777).toString(8).padStart(3, '0');
}

/**
 * What is wrong with what somebody typed, or nothing when it will do.
 *
 * Refused rather than interpreted: `chmod 8` and `chmod rw-` are both somebody
 * expecting something this does not do, and guessing at either would change
 * permissions on a server to a number nobody asked for.
 */
export function modeComplaint(typed: string): string | null {
  const trimmed = typed.trim();

  if (trimmed === '') {
    return 'A mode is needed, as octal digits - 644, 755, 2775.';
  }

  if (!/^[0-7]{3,4}$/.test(trimmed)) {
    return `'${trimmed}' is not three or four octal digits. Letters like rwx are not read here.`;
  }

  return null;
}

/** The number behind those digits. Only for text `modeComplaint` accepted. */
export function parseMode(typed: string): number {
  return parseInt(trimmedOf(typed), 8);
}

function trimmedOf(typed: string): string {
  return typed.trim();
}
