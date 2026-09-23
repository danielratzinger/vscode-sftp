import isNotFound from '../notFound';

describe('isNotFound', () => {
  it('knows SFTP, local and FTP ways of saying it', () => {
    expect(isNotFound({ code: 2, message: 'No such file' })).toBe(true);
    expect(isNotFound({ code: 'ENOENT' })).toBe(true);
    expect(isNotFound(new Error('550 /www/a.php: does not exist'))).toBe(true);
  });

  // A delete that fails for these is not done, and must be tried again.
  it('does not mistake other failures for it', () => {
    expect(isNotFound({ code: 3, message: 'Permission denied' })).toBe(false);
    expect(isNotFound({ code: 'ECONNRESET' })).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});
