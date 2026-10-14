import * as fse from 'fs-extra';
import * as path from 'path';
import { FileType } from './fs/fileSystem';
import { blobAt, blobIdOf } from './gitBlob';

/**
 * Of some files about to be uploaded, the ones the server has newer than the
 * uploader assumes.
 *
 * A catch-up from a checkout assumes the server has what the branch started
 * from. Where it does not - work deployed straight from a folder and never
 * committed - the server holds changes nobody else has, and uploading the
 * branch takes them back. That happened: a checkout made from a commit weeks
 * old caught a server up to it, and files edited and deployed since went back
 * to their old selves.
 *
 * With a base revision the question is asked exactly: does the server's file
 * differ from the base's? Sizes first, bytes only when the sizes agree. A file
 * the base never had but the server does is newer too. Without one, all there
 * is to go on is time - the server's copy written after the local one. A file
 * the server does not have has nothing on it to lose.
 */

interface RemoteLike {
  lstat(path: string): Promise<{ type: FileType; size: number; mtime: number }>;
  readFile(path: string): Promise<string | Buffer>;
}

export async function aheadOnServer(option: {
  remoteFs: RemoteLike;
  /** The checkout git answers about. */
  checkout: string;
  /** What the server is assumed to have; nothing to compare times instead. */
  base?: string;
  files: string[];
  remotePathOf(file: string): string;
}): Promise<string[]> {
  const ahead: string[] = [];

  for (const file of option.files) {
    const remotePath = option.remotePathOf(file);

    let remote;
    try {
      remote = await option.remoteFs.lstat(remotePath);
    } catch (error) {
      continue;
    }
    if (remote.type !== FileType.File) {
      continue;
    }

    if (option.base) {
      const blob = await blobAt(
        option.checkout,
        option.base,
        path.relative(option.checkout, file)
      );
      if (!blob || blob.size !== remote.size) {
        ahead.push(file);
        continue;
      }

      const content = await option.remoteFs.readFile(remotePath);
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
      if ((await blobIdOf(option.checkout, bytes)) !== blob.id) {
        ahead.push(file);
      }
      continue;
    }

    const local = await fse.lstat(file).catch(() => undefined);
    if (local && remote.mtime > local.mtimeMs + 1000) {
      ahead.push(file);
    }
  }

  return ahead;
}
