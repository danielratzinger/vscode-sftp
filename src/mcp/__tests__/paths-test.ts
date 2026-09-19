import { normaliseRemote, outsideMessage, resolveWithin } from '../paths';

describe('resolveWithin', () => {
  const ROOT = '/srv/app';

  it('accepts the root and everything below it', () => {
    expect(resolveWithin(ROOT, '/srv/app')).toBe('/srv/app');
    expect(resolveWithin(ROOT, '/srv/app/src/Kernel.php')).toBe(
      '/srv/app/src/Kernel.php'
    );
  });

  it('refuses a path that climbs out', () => {
    // Without this, the file is read from a part of the server nobody exposed
    // and written outside the project folder.
    expect(resolveWithin(ROOT, '/etc/passwd')).toBeUndefined();
    expect(resolveWithin(ROOT, '/srv/app/../../etc/passwd')).toBeUndefined();
    expect(resolveWithin(ROOT, '/srv/app/../other-client/db.php')).toBeUndefined();
  });

  it('refuses a neighbour whose name starts the same way', () => {
    expect(resolveWithin(ROOT, '/srv/appendix/secrets.php')).toBeUndefined();
  });

  it('takes a relative path as relative to the root', () => {
    expect(resolveWithin(ROOT, 'src/Kernel.php')).toBe('/srv/app/src/Kernel.php');
    expect(resolveWithin(ROOT, './src')).toBe('/srv/app/src');
    expect(resolveWithin(ROOT, '../escape')).toBeUndefined();
  });

  it('canonicalises, so one file has one spelling', () => {
    expect(resolveWithin(ROOT, '/srv/app//src/./Kernel.php')).toBe(
      '/srv/app/src/Kernel.php'
    );
    expect(resolveWithin(ROOT, '/srv/app/src/')).toBe('/srv/app/src');
  });

  it('treats a backslash as a separator, not as part of a name', () => {
    // Some servers do. A file genuinely named with one is far rarer than this
    // being an attempt to get past the check.
    expect(resolveWithin(ROOT, '/srv/app/..\\..\\etc/passwd')).toBeUndefined();
  });

  it('refuses an empty path rather than defaulting to the root', () => {
    expect(resolveWithin(ROOT, '')).toBeUndefined();
    expect(resolveWithin(ROOT, '   ')).toBeUndefined();
  });

  it('lets a connection rooted at / expose the server, as configured', () => {
    expect(resolveWithin('/', '/etc/passwd')).toBe('/etc/passwd');
  });

  it('is not fooled by a trailing slash on the root', () => {
    expect(resolveWithin('/srv/app/', '/srv/app/x')).toBe('/srv/app/x');
    expect(resolveWithin('/srv/app/', '/srv/other')).toBeUndefined();
  });
});

describe('normaliseRemote', () => {
  it('leaves the root alone', () => {
    expect(normaliseRemote('/')).toBe('/');
    expect(normaliseRemote('')).toBe('/');
  });
});

describe('outsideMessage', () => {
  it('says the same thing whether or not the path exists', () => {
    const real = outsideMessage('/srv/app', '/etc/passwd');
    const imagined = outsideMessage('/srv/app', '/etc/nothing-here');

    expect(real.replace('passwd', 'nothing-here')).toBe(imagined);
    expect(real).toContain('outside /srv/app');
  });
});
