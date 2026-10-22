import isNotFound from '../notFound';

describe('isNotFound', () => {
  it('knows SFTP, local and FTP ways of saying it', () => {
    expect(isNotFound({ code: 2, message: 'No such file' })).toBe(true);
    expect(isNotFound({ code: 'ENOENT' })).toBe(true);
    expect(isNotFound(new Error('550 /www/a.php: does not exist'))).toBe(true);
  });

  // IIS, as Azure App Service's FTP answers a LIST of a folder not made yet.
  it('knows the Windows way of saying it', () => {
    expect(
      isNotFound(Object.assign(new Error('The system cannot find the path specified. '), { code: 550 }))
    ).toBe(true);
    expect(isNotFound(new Error('The system cannot find the file specified.'))).toBe(true);
  });

  // The same 550 means access denied, and that is not "not there".
  it('does not take every 550 for it', () => {
    expect(isNotFound(Object.assign(new Error('Access is denied. '), { code: 550 }))).toBe(false);
  });

  // A delete that fails for these is not done, and must be tried again.
  it('does not mistake other failures for it', () => {
    expect(isNotFound({ code: 3, message: 'Permission denied' })).toBe(false);
    expect(isNotFound({ code: 'ECONNRESET' })).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});
