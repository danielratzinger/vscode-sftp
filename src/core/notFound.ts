/**
 * Whether an error says the file is not there.
 *
 * SFTP reports it as status 2, the local file system and FTP as `ENOENT`, and
 * some servers only in the message.
 */
export default function isNotFound(error: any): boolean {
  const code = error && (error.code || error.errno);
  return (
    code === 2 ||
    code === 'ENOENT' ||
    /no such file|not found|does not exist/i.test((error && error.message) || '')
  );
}
