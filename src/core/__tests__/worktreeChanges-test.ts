import { parseNameStatus, parsePorcelain } from '../worktreeChanges';

/**
 * The fixtures are git's own output, taken from a checkout with 174 changed
 * files in it and one with a single untracked folder.
 */
describe('what a branch changed', () => {
  it('reads a diff against the branch being deployed', () => {
    const { changed, deleted } = parseNameStatus(
      [
        'M\t.github/workflows/ci-tests.yml',
        'M\tREADME.md',
        'A\tadmin/includes/php/admin.inc.php',
        'D\tlegacy/old.php',
      ].join('\n')
    );

    expect(changed).toEqual([
      '.github/workflows/ci-tests.yml',
      'README.md',
      'admin/includes/php/admin.inc.php',
    ]);
    expect(deleted).toEqual(['legacy/old.php']);
  });

  it('treats a rename as a new file and a gone one', () => {
    // The server has the old path and needs the new one; nothing else knows
    // the two are related.
    const { changed, deleted } = parseNameStatus('R096\tsrc/old.php\tsrc/new.php');

    expect(changed).toEqual(['src/new.php']);
    expect(deleted).toEqual(['src/old.php']);
  });

  it('ignores the blank line git ends with', () => {
    expect(parseNameStatus('M\ta.php\n').changed).toEqual(['a.php']);
    expect(parseNameStatus('').changed).toEqual([]);
  });
});

describe('what is not committed yet', () => {
  it('reads modified, added and untracked files', () => {
    const { changed, deleted } = parsePorcelain(
      [' M src/a.php', 'A  src/b.php', '?? marketing/index.php', 'MM src/c.php'].join('\n')
    );

    expect(changed).toEqual([
      'src/a.php',
      'src/b.php',
      'marketing/index.php',
      'src/c.php',
    ]);
    expect(deleted).toEqual([]);
  });

  it('reads a deletion from either column', () => {
    const { changed, deleted } = parsePorcelain([' D src/a.php', 'D  src/b.php'].join('\n'));

    expect(changed).toEqual([]);
    expect(deleted).toEqual(['src/a.php', 'src/b.php']);
  });

  it('reads a rename', () => {
    const { changed, deleted } = parsePorcelain('R  src/old.php -> src/new.php');

    expect(changed).toEqual(['src/new.php']);
    expect(deleted).toEqual(['src/old.php']);
  });

  it('unquotes a path git had to quote', () => {
    // Anything outside plain ASCII, or with a quote or a newline in it.
    expect(parsePorcelain('?? "src/a file \\"quoted\\".php"').changed).toEqual([
      'src/a file "quoted".php',
    ]);
    expect(parsePorcelain('?? "src/line\\nbreak.php"').changed).toEqual([
      'src/line\nbreak.php',
    ]);
  });

  it('ignores short lines and the trailing blank', () => {
    expect(parsePorcelain('?? a.php\n').changed).toEqual(['a.php']);
    expect(parsePorcelain('').changed).toEqual([]);
  });
});
