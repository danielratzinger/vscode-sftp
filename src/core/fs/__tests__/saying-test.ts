import saying from '../saying';
import isNotFound from '../../notFound';

function sftpError(message: string, code: number) {
  const error: any = new Error(message);
  error.code = code;
  return error;
}

describe('an SFTP error that says what it was about', () => {
  it('names the operation and the file, in the message and the logged stack', () => {
    const error = saying(sftpError('Permission denied', 3), 'download /srv/app/.env');

    expect(error.message).toBe('Permission denied: could not download /srv/app/.env');
    expect(error.stack.split('\n')[0]).toBe(
      'Error: Permission denied: could not download /srv/app/.env'
    );
    expect(error.code).toBe(3);
  });

  it('fixes a stack that was read before', () => {
    const error = sftpError('Failure', 4);
    expect(error.stack.split('\n')[0]).toBe('Error: Failure');

    saying(error, 'list /x');
    expect(error.stack.split('\n')[0]).toBe(`Error: ${error.message}`);
    expect(error.stack).toContain('saying-test');
  });

  it('says when the server gave no reason at all', () => {
    const error = saying(sftpError('Failure', 4), 'list /srv/app/cache');

    expect(error.message).toMatch(/^Failure: could not list \/srv\/app\/cache \(the server gave no reason/);
  });

  it('is said once, by whoever was closest', () => {
    const error = saying(saying(sftpError('Failure', 4), 'open /a'), 'download /a');

    expect(error.message.match(/could not/g)).toHaveLength(1);
    expect(error.message).toContain('open /a');
  });

  it('is still a missing file to whatever asks', () => {
    expect(isNotFound(saying(sftpError('No such file', 2), 'stat /gone'))).toBe(true);
  });
});
