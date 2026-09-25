import * as path from 'path';
import { PassThrough } from 'stream';
import { createGunzip } from 'zlib';
import * as fse from 'fs-extra';
import * as tar from 'tar';
import { watchForStall } from '../fs/operationTimeout';
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
   * The walk's file-level predicate, asked of files and not of folders - which
   * is what makes a folder with a dot in its name safe from it.
   */
  fileFilter?: ((fsPath: string) => boolean) | null;
  /**
   * Called before a file is written over, with the file about to go. The
   * file-by-file transfer does this per file; skipping it here would quietly
   * take away the copy somebody is relying on.
   */
  keepReplaced?(
    localPath: string,
    incoming: { size?: number; mtime: number }
  ): Promise<void>;
  /**
   * Give up if not one byte arrives for this long. Zero or less turns it off.
   *
   * An archive is one operation that runs for as long as the whole transfer, so
   * unlike a single file it has no natural end to time out against - only
   * silence. Without this, anything that stops the bytes stops the transfer for
   * good, and the only sign is a progress bar that never moves.
   */
  stallAfter?: number;
  /** Told how far it has got, as each file lands. */
  onProgress?(sofar: ExtractResult): void;
  /**
   * Defaults to on; false skips the check that each file is the length the
   * archive said it would be, the way `verifyTransfer` does for one at a time.
   */
  verify?: boolean;
}

/**
 * Errors that are not about the entry that hit them.
 *
 * A name this machine cannot spell is one file's problem and the rest of the
 * transfer stands. A full disk is not: every entry after it fails the same way,
 * and treating each as its own small failure turns one condition into thousands
 * of warnings and a folder full of half-written files. Nor is there any point
 * going round again file by file, which would fill the disk just as surely.
 */
const NOT_ABOUT_THIS_ENTRY = [
  'ENOSPC', // no space left
  'EDQUOT', // over quota
  'EROFS', // read-only file system
  'EIO', // the disk itself
  'EMFILE', // this process has no file descriptors left
  'ENFILE', // nor has the machine
];

export function isAboutTheMachine(error: any): boolean {
  return Boolean(error) && NOT_ABOUT_THIS_ENTRY.indexOf(error.code) !== -1;
}

/**
 * How many entries may fail on their own before it stops being a coincidence.
 *
 * Reached without any of the codes above, it still says the trouble is with the
 * place they are going rather than with each of them.
 */
const REFUSALS_ALLOWED = 20;

/**
 * How much of a file is held while the entry before it is still being written.
 *
 * Small on purpose: it is what makes the stream stop rather than memory fill
 * when one file is waiting behind another.
 */
const HOLDING_BYTES = 64 * 1024;

export interface ExtractResult {
  files: number;
  bytes: number;
  skipped: number;
  /** Entries this machine would not write. One file, not the transfer. */
  refused: number;
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

/**
 * What to say when a file is not the length the archive said it would be, or
 * nothing when it is.
 */
export function sizeComplaint(
  expected: number,
  landed: number
): string | null {
  if (landed === expected) {
    return null;
  }

  return (
    `arrived ${
      landed < expected ? 'incomplete' : 'longer than the archive said'
    }: expected ${expected} bytes, got ${landed}`
  );
}

function writeEntry(
  held: NodeJS.ReadableStream,
  target: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    // 'w' truncates what is already there and keeps the file it is: the inode
    // stays, so hard links hold and a symlink is written through, exactly as
    // the file-by-file transfer does it.
    const writer = fse.createWriteStream(target, { flags: 'w' });
    writer.once('error', reject).once('finish', () => resolve());
    held.once('error', reject);
    held.pipe(writer);
  });
}

async function linkEntry(linkpath: string, target: string): Promise<void> {
  try {
    await fse.symlink(linkpath, target);
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
 *
 * What an entry is to be done with is decided as it arrives, because that much
 * can be: the name, the type and the filters need nothing but the header. A
 * file's bytes are then taken straight into a small holding buffer, and the
 * slow part - making folders, keeping a copy of what is about to go - happens
 * after, one entry at a time.
 *
 * Nothing pauses the stream the archive is arriving on. That was tried and it
 * deadlocks: the bytes an entry is waiting for are in the stream that was
 * paused to wait for it. Backpressure has to travel the other way, from the
 * holding buffer back up through the parser, which is what piping it does.
 */
export function extractInto(
  source: NodeJS.ReadableStream,
  option: ExtractOption
): Promise<ExtractResult> {
  const result: ExtractResult = { files: 0, bytes: 0, skipped: 0, refused: 0 };
  const parser = new (tar as any).Parse();
  const unzip = createGunzip();

  let failure: Error | null = null;
  let work: Promise<void> = Promise.resolve();

  return new Promise<ExtractResult>((resolve, reject) => {
    const fail = (error: Error) => {
      if (!failure) {
        failure = error;
        reject(error);
      }
    };

    /**
     * Queues the filesystem side of an entry, in the order the entries came.
     *
     * One entry that cannot be written is one file's failure, which is what it
     * is file by file too: a name Windows has no way to spell, a symlink it
     * will not allow. The stream itself failing is a different matter and
     * arrives on the parser instead.
     */
    const queue = (what: string, job: () => Promise<void>) => {
      work = work.then(() =>
        job().catch(error => {
          if (isAboutTheMachine(error)) {
            // Not this entry's failure, and not one to go round again for.
            error.noPointRetrying = true;
            fail(error);
            return;
          }

          result.refused += 1;

          // Said once each up to a point, and then only counted: one condition
          // should not fill the log with a line per file.
          if (result.refused <= REFUSALS_ALLOWED) {
            logger.warn(`[archive] could not write ${what}: ${error.message}`);
          } else if (result.refused === REFUSALS_ALLOWED + 1) {
            logger.warn(
              `[archive] more entries could not be written; counting them ` +
                `rather than listing them`
            );
          }

          if (result.refused > REFUSALS_ALLOWED) {
            const tooMany: any = new Error(
              `${result.refused} entries could not be written, which is about ` +
                `where they are going and not about any one of them ` +
                `(last: ${error.message})`
            );
            tooMany.noPointRetrying = true;
            fail(tooMany);
          }
        })
      );
    };

    parser.on('entry', (entry: any) => {
      const name = String(entry.path);
      const target = entryTarget(option.localBase, name);

      if (failure || !target) {
        if (!failure && !isArchiveRoot(name)) {
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

      // The walk asks this of files and symlinks and not of folders, which is
      // what keeps a folder with a dot in its name out of its reach.
      if (
        entry.type !== 'Directory' &&
        option.fileFilter &&
        !option.fileFilter(target)
      ) {
        result.skipped += 1;
        entry.resume();
        return;
      }

      if (entry.type === 'Directory') {
        entry.resume();
        queue(name, () => fse.mkdirp(target));
        return;
      }

      if (entry.type === 'SymbolicLink') {
        const linkpath = entry.linkpath;
        entry.resume();
        queue(name, async () => {
          await fse.mkdirp(path.dirname(target));
          await linkEntry(linkpath, target);
        });
        return;
      }

      if (entry.type !== 'File') {
        // Devices, fifos, hard links: the file-by-file transfer has nothing to
        // say about them either.
        logger.debug(`[archive] nothing to do with ${entry.type} ${name}`);
        result.skipped += 1;
        entry.resume();
        return;
      }

      // Taken now, not when its turn comes: an entry nobody is reading is an
      // entry the parser cannot get past, and the parser is what the rest of
      // the archive arrives through. The buffer is small on purpose, so a file
      // held up behind another one stops the stream rather than filling memory.
      const held = new PassThrough({ highWaterMark: HOLDING_BYTES });
      entry.once('error', (error: Error) => held.destroy(error));
      entry.pipe(held);

      const size = entry.size || 0;
      const mtime = entry.mtime;
      const atime = entry.atime;

      queue(name, async () => {
        if (failure) {
          held.resume();
          return;
        }

        await fse.mkdirp(path.dirname(target));

        if (option.keepReplaced) {
          await option.keepReplaced(target, {
            size,
            mtime: mtime ? mtime.getTime() : 0,
          });
        }

        await writeEntry(held, target);

        if (option.verify !== false) {
          // What landed, not what was counted on the way: the gzip trailer says
          // the archive arrived whole, and this says each file did. Asked of the
          // file system, so it also catches a write that stopped short without
          // saying so.
          const landed = await fse.stat(target);
          const complaint = sizeComplaint(size, landed.size);
          if (complaint) {
            throw new Error(complaint);
          }
        }

        if (mtime) {
          try {
            await fse.utimes(target, atime || mtime, mtime);
          } catch (error) {
            logger.debug(
              `[archive] could not set the times on ${target}: ${error.message}`
            );
          }
        }

        result.files += 1;
        result.bytes += size;

        if (option.onProgress) {
          option.onProgress(result);
        }
      });
    });

    const watchdog = watchForStall(
      option.stallAfter === undefined ? 0 : option.stallAfter,
      'reading the archive',
      fail
    );
    source.on('data', () => watchdog.progress());

    parser.on('error', fail);
    unzip.on('error', fail);
    source.on('error', error => {
      watchdog.stop();
      fail(error);
    });

    parser.on('end', () => {
      watchdog.stop();

      // The last entries are still being written when the archive ends.
      work.then(() => {
        if (failure) {
          return;
        }

        // Nothing landed and something was turned away: whatever is wrong is
        // wrong with every entry, not with one of them, and calling that a
        // finished transfer would be a lie.
        if (result.files === 0 && result.refused > 0) {
          fail(
            new Error(
              `nothing could be written: ${result.refused} entr${
                result.refused === 1 ? 'y' : 'ies'
              } turned away`
            )
          );
          return;
        }

        resolve(result);
      }, fail);
    });

    source.pipe(unzip).pipe(parser);
  });
}
