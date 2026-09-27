import { formatMode, modeComplaint, parseMode } from '../permissionMode';

describe('permissions as digits', () => {
  it('shows the digits a stat carries, without the file-type bits', () => {
    // 0o100644 is a regular file, 0o644. The type is not part of the answer.
    expect(formatMode(0o100644)).toBe('644');
    expect(formatMode(0o040755)).toBe('755');
    expect(formatMode(0o104755)).toBe('4755');
  });

  it('pads a mode that would otherwise read as two digits', () => {
    expect(formatMode(0o100044)).toBe('044');
  });

  it('reads back what it showed', () => {
    expect(parseMode('644')).toBe(0o644);
    expect(parseMode(' 755 ')).toBe(0o755);
    expect(parseMode('2775')).toBe(0o2775);
  });
});

describe('a mode somebody typed', () => {
  it('accepts three or four octal digits', () => {
    expect(modeComplaint('644')).toBeNull();
    expect(modeComplaint('755')).toBeNull();
    expect(modeComplaint('2775')).toBeNull();
    expect(modeComplaint('  600  ')).toBeNull();
  });

  it('needs something', () => {
    expect(modeComplaint('')).toMatch(/needed/);
  });

  it('refuses a digit that is not octal, rather than reading it as one', () => {
    expect(modeComplaint('648')).toMatch(/not three or four octal digits/);
    expect(modeComplaint('799')).toMatch(/octal/);
  });

  it('refuses letters instead of guessing at them', () => {
    // `rw-r--r--` is what somebody expects this to take, and it does not.
    expect(modeComplaint('rw-r--r--')).toMatch(/Letters like rwx/);
    expect(modeComplaint('u+x')).toMatch(/octal/);
  });

  it('refuses too few and too many digits', () => {
    expect(modeComplaint('64')).toMatch(/octal/);
    expect(modeComplaint('06440')).toMatch(/octal/);
  });
});
