import { diff } from '../diff';

describe('diff', () => {
  it('says nothing when the files are the same', () => {
    const result = diff('a\nb\nc\n', 'a\nb\nc\n');

    expect(result.changed).toBe(false);
    expect(result.text).toBe('');
  });

  it('ignores a trailing newline that is not a line', () => {
    expect(diff('a\nb', 'a\nb\n').changed).toBe(false);
  });

  it('shows a changed line with context and correct line numbers', () => {
    const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n');
    const after = ['one', 'two', 'three', 'FOUR', 'five', 'six', 'seven'].join('\n');

    const result = diff(before, after);

    expect(result.text).toContain('-four');
    expect(result.text).toContain('+FOUR');
    expect(result.text).toContain('@@ -1,7 +1,7 @@');
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });

  it('starts the hunk where the change is, not at the top of the file', () => {
    const before = Array.from({ length: 100 }, (unused, i) => `line ${i}`).join('\n');
    const after = before.replace('line 60', 'line sixty');

    const result = diff(before, after);

    // Three lines of context either side, and nothing else.
    expect(result.text).toContain('@@ -58,7 +58,7 @@');
    expect(result.text).not.toContain('line 10');
    expect(result.text.split('\n')).toHaveLength(9);
  });

  it('reports separate changes as separate hunks', () => {
    const before = Array.from({ length: 60 }, (unused, i) => `line ${i}`).join('\n');
    const after = before.replace('line 5', 'FIVE').replace('line 50', 'FIFTY');

    const result = diff(before, after);

    expect(result.text.match(/^@@/gm)).toHaveLength(2);
  });

  it('handles an addition at the end and a deletion at the start', () => {
    expect(diff('a\nb', 'a\nb\nc').added).toBe(1);
    expect(diff('a\nb\nc', 'b\nc').removed).toBe(1);
  });

  it('handles one side being empty', () => {
    expect(diff('', 'a\nb').added).toBe(2);
    expect(diff('a\nb', '').removed).toBe(2);
  });

  it('summarises rather than stopping when the change is enormous', () => {
    // Two generated files with nothing in common: an exact comparison would be
    // four trillion cells, and a summary is worth more than no answer.
    const left = Array.from({ length: 3000 }, (unused, i) => `left ${i}`).join('\n');
    const right = Array.from({ length: 3000 }, (unused, i) => `right ${i}`).join('\n');

    const result = diff(left, right);

    expect(result.summarised).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.text).toContain('too large to compare');
  });

  it('still compares a small change inside two enormous files', () => {
    // Because the identical head and tail are trimmed before anything is
    // computed, which is what the usual case looks like.
    const lines = Array.from({ length: 50000 }, (unused, i) => `line ${i}`);
    const left = lines.join('\n');
    const right = lines.slice();
    right[25000] = 'changed';

    const result = diff(left, right.join('\n'));

    expect(result.summarised).toBe(false);
    expect(result.added).toBe(1);
    expect(result.text).toContain('@@ -24998,7 +24998,7 @@');
  });
});
