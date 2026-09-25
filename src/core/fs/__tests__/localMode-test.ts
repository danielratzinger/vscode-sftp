import { localMode } from '../localFileSystem';

const file = (mode: number) => ({ mode, isDirectory: () => false });
const dir = (mode: number) => ({ mode, isDirectory: () => true });

describe('the mode a local file is reported to have', () => {
  it('is the mode it has, where files have modes', () => {
    expect(localMode(file(0o100644), 'darwin')).toBe(0o644);
    expect(localMode(file(0o100755), 'linux')).toBe(0o755);
    expect(localMode(dir(0o040750), 'linux')).toBe(0o750);
  });

  it('is not what Windows made up, where they do not', () => {
    // Node reports 0666 for a writable file and 0444 for a read-only one. Sent
    // to a server, the first is world-writable - which suexec refuses to run -
    // and the second is a file nobody can write.
    expect(localMode(file(0o100666), 'win32')).toBe(0o644);
    expect(localMode(file(0o100444), 'win32')).toBe(0o644);
    expect(localMode(dir(0o040666), 'win32')).toBe(0o755);
  });
});
