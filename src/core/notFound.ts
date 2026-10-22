/**
 * Whether an error says the file is not there.
 *
 * SFTP reports it as status 2, the local file system and FTP as `ENOENT`, and
 * some servers only in the message. IIS - Azure App Service's FTP among
 * others - says it the Windows way, "The system cannot find the path
 * specified" for a folder and "... the file specified" for a file. Not knowing
 * that read a folder not created yet as a server that would not answer: the
 * copy kept before an upload could not be made, so nothing in a new folder was
 * ever uploaded.
 *
 * FTP's 550 alone is not enough: the same code means "access denied", and a
 * file that cannot be read is not a file that is not there.
 */
const NOT_THERE = /no such file|not found|does not exist|cannot find the (path|file) specified/i;

export default function isNotFound(error: any): boolean {
  const code = error && (error.code || error.errno);
  return code === 2 || code === 'ENOENT' || NOT_THERE.test((error && error.message) || '');
}
