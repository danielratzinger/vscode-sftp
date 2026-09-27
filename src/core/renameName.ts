/**
 * What is wrong with a name somebody typed for a rename, or nothing when it
 * will do.
 *
 * A rename changes what a file is called and not where it lives, so a separator
 * is refused rather than quietly making a move out of it, and `.` and `..` name
 * a folder rather than a file in one.
 *
 * On its own here, with nothing imported, because the handler that uses it sits
 * inside a cycle of modules that cannot be loaded without an editor around them
 * - and a rule about names should be testable without one.
 */
export function nameComplaint(name: string): string | null {
  const trimmed = name.trim();

  if (trimmed === '') {
    return 'A name is needed.';
  }

  if (/[\\/]/.test(trimmed)) {
    return 'A name cannot hold a slash. Renaming does not move a file.';
  }

  if (trimmed === '.' || trimmed === '..') {
    return `'${trimmed}' names a folder, not a file in one.`;
  }

  // tslint:disable-next-line:no-control-regex
  if (/[\u0000-\u001f]/.test(trimmed)) {
    return 'A name cannot hold control characters.';
  }

  return null;
}
