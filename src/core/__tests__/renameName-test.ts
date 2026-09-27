import { nameComplaint } from '../renameName';

describe('a name typed for a rename', () => {
  it('accepts an ordinary one', () => {
    expect(nameComplaint('index.php')).toBeNull();
    expect(nameComplaint('a file with spaces.txt')).toBeNull();
    expect(nameComplaint('.htaccess')).toBeNull();
    expect(nameComplaint('ümlaut.txt')).toBeNull();
  });

  it('needs something to be typed', () => {
    expect(nameComplaint('')).toMatch(/needed/);
    expect(nameComplaint('   ')).toMatch(/needed/);
  });

  it('refuses a separator rather than quietly moving the file', () => {
    expect(nameComplaint('app/index.php')).toMatch(/slash/);
    expect(nameComplaint('..\\\\elsewhere')).toMatch(/slash/);
    expect(nameComplaint('/absolute')).toMatch(/slash/);
  });

  it('refuses the two names that mean a folder', () => {
    expect(nameComplaint('.')).toMatch(/names a folder/);
    expect(nameComplaint('..')).toMatch(/names a folder/);
  });

  it('refuses control characters, which no server wants in a name', () => {
    expect(nameComplaint('two\nlines.txt')).toMatch(/control characters/);
  });
});
