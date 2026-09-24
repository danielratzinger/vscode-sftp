import * as path from 'path';
import { createGunzip } from 'zlib';
import * as fse from 'fs-extra';
import * as tar from 'tar';
import logger from '../../logger';

/** What the caller wants done with the entries as they arrive. */
export interface ExtractOption {
  /** The folder the archive's contents are relative to. */
  localBase: string;
  /**
   * The same predicate the file-by-file walk consults, asked with the local
   * path - it relativises either side against its own root, so the answer is
   * the one that walk would have given.
   */
  ignore?: ((fsPath: string) => boolean) | null;
  /**
   * Called before a file is written over, with the file about to go. The
   * file-by-file transfer does this per file; skipping it here would quietly
   * take away the copy somebody is relying on.
   */
  keepReplaced?(
    localPath: string,
    incoming: { size?: number; mtime: number }
  ): Promise<void>;
}

export interface ExtractResult {
  files: number;
  bytes: number;
  skipped: number;
}

/**
 * Where an entry should land, or null when it has no business landing anywhere.
 *
 * tar names entries relative to what it was told to pack, `./` and all, but an
 * archive is only ever as trustworthy as whoever wrote it. An absolute name or
 * one that climbs out of the folder is refused rather than followed.
 */
export function entryTarget(localBase: string, name: string): string | null {
  const cleaned = trimName(name);
  if (cleaned === '' || cleaned === '.') {
    return null;
  }

  if (path.posix.isAbsolute(cleaned) || path.win32.isAbsolute(cleaned)) {
    return null;
  }

  const parts = cleaned.split(/[\\/]/);
  if (parts.some(part => part === '..')) {
    return null;
  }

  return path.join(localBase, ...parts);
}

function trimName(name: string): string {
  return name.replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * The entry tar writes for the folder it was pointed at itself. There is
 * nothing to do with it, which is not the same as there being something wrong
 * with it.
 */
export function isArchiveRoot(name: string): boolean {
  const cleaned = trimName(name);
  return cleaned === '' || cleaned === '.';
}

function writeEntry(entry: any, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 'w' truncates what is already there and keeps the file it is: the inode
    // stays, so hard links hold and a symlink is written through, exactly as
    // the file-by-file transfer does it.
    const writer = fse.createWriteStream(target, { flags: 'w' });
    writer.once('error', reject).once('finish', () => resolve());
    entry.once('error', reject);
    entry.pipe(writer);
  });
}

async function linkEntry(entry: any, target: string): Promise<void> {
  try {
    await fse.symlink(entry.linkpath, target);
  } catch (error) {
    // A link that is already there is left as it is, which is what the
    // file-by-file transfer does with one.
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Reads a gzipped tar off a stream and writes it into `localBase`.
 *
 * Every entry is written the way a single transfer would write it, because the
 * point of the archive is to arrive faster, not to arrive differently.
 */
export function extractInto(
  source: NodeJS.ReadableStream,
  option: ExtractOption
): Promise<ExtractResult> {
  const result: ExtractResult = { files: 0, bytes: 0, skipped: 0 };
  const parser = new (tar as any).Parse();
  const unzip = createGunzip();

  let failure: Error | null = null;
  let work: Promise<void> = Promise.resolve();

  const handle = async (entry: any) => {
    const name = String(entry.path);
    const target = entryTarget(option.localBase, name);

    if (!target) {
      if (!isArchiveRoot(name)) {
        logger.warn(`[archive] refused an entry named ${name}`);
        result.skipped += 1;
      }
      entry.resume();
      return;
    }

    if (option.ignore && option.ignore(target)) {
      result.skipped += 1;
      entry.resume();
      return;
    }

    if (entry.type === 'Directory') {
      await fse.mkdirp(target);
      entry.resume();
      return;
    }

    if (entry.type === 'SymbolicLink') {
      await fse.mkdirp(path.dirname(target));
      await linkEntry(entry, target);
      entry.resume();
      return;
    }

    if (entry.type !== 'File') {
      // Devices, fifos, hard links: the file-by-file transfer has nothing to
      // say about them either.
      logger.debug(`[archive] nothing to do with ${entry.type} ${entry.path}`);
      result.skipped += 1;
      entry.resume();
      return;
    }

    await fse.mkdirp(path.dirname(target));

    if (option.keepReplaced) {
      await option.keepReplaced(target, {
        size: entry.size,
        mtime: entry.mtime ? entry.mtime.getTime() : 0,
      });
    }

    await writeEntry(entry, target);

    if (entry.mtime) {
      try {
        await fse.utimes(target, entry.atime || entry.mtime, entry.mtime);
      } catch (error) {
        logger.debug(
          `[archive] could not set the times on ${target}: ${error.message}`
        );
      }
    }

    result.files += 1;
    result.bytes += entry.size || 0;
  };

  return new Promise<ExtractResult>((resolve, reject) => {
    const fail = (error: Error) => {
      if (!failure) {
        failure = error;
        reject(error);
      }
    };

    parser.on('entry', (entry: any) => {
      if (failure) {
        entry.resume();
        return;
      }

      // Nothing more is read while an entry is being dealt with, so an entry
      // waiting on a backup copy cannot pile up in memory behind it.
      source.pause();
      work = work.then(
        () =>
          handle(entry).then(
            () => {
              source.resume();
            },
            error => {
              source.resume();
              entry.resume();
              fail(error);
            }
          ),
        () => undefined
      );
    });

    parser.on('error', fail);
    unzip.on('error', fail);
    source.on('error', fail);

    parser.on('end', () => {
      // The last entries are still being written when the archive ends.
      work.then(() => {
        if (!failure) {
          resolve(result);
        }
      }, fail);
    });

    source.pipe(unzip).pipe(parser);
  });
}
