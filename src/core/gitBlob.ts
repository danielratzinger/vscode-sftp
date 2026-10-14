import { execFile } from 'child_process';

/**
 * A file as git has it at a revision, and whether some bytes are that file.
 *
 * A catch-up uploads what a branch changed, on the assumption that the server
 * has what the branch started from. When it does not - work deployed straight
 * from an uncommitted folder, say - the files it would overwrite on the server
 * are newer than anything git knows, and uploading the branch takes them back.
 * Asking git what the base had, and comparing, is how that is caught before
 * rather than after.
 */

function git(cwd: string, args: string[], input?: Buffer): Promise<string | undefined> {
  return new Promise(resolve => {
    const child = execFile(
      'git',
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => resolve(error ? undefined : String(stdout).trim())
    );
    if (input !== undefined) {
      child.stdin!.end(input);
    }
  });
}

export interface Blob {
  id: string;
  size: number;
}

/**
 * The file at `relative` in `revision`, or undefined when the revision does not
 * have it - which, for a file the server has, is itself a difference.
 */
export async function blobAt(
  checkout: string,
  revision: string,
  relative: string
): Promise<Blob | undefined> {
  const spec = `${revision}:${relative.split('\\').join('/')}`;
  const id = await git(checkout, ['rev-parse', '--verify', '--quiet', spec]);
  if (!id) {
    return undefined;
  }

  const size = await git(checkout, ['cat-file', '-s', id]);
  return size === undefined ? undefined : { id, size: parseInt(size, 10) };
}

/** The id git would give these bytes, without storing them. */
export function blobIdOf(checkout: string, bytes: Buffer): Promise<string | undefined> {
  return git(checkout, ['hash-object', '--stdin'], bytes);
}
