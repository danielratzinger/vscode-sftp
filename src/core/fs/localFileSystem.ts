import * as fs from 'fs';
import * as fse from 'fs-extra';
import FileSystem, { FileEntry, FileStats, FileOption } from './fileSystem';

/**
 * Windows has no mode to report, so Node makes one up: 0666 for a file anyone
 * may write, 0444 for a read-only one, and the same for folders. Carried to a
 * server as if it meant something, 0666 is a world-writable file - which some
 * hosting refuses to run at all, PHP under suexec among them - and 0444 is one
 * nobody can write.
 *
 * So on Windows a local mode is not evidence of anything and is not treated as
 * such: a file is 0644 and a folder 0755, the modes a file put there by hand
 * would have. `filePerm` and `dirPerm` still override both, as always.
 */
const MODE_FOR_FILE = 0o644;
const MODE_FOR_DIRECTORY = 0o755;

export function localMode(
  stat: { mode: number; isDirectory(): boolean },
  platform: string = process.platform
): number {
  if (platform === 'win32') {
    return stat.isDirectory() ? MODE_FOR_DIRECTORY : MODE_FOR_FILE;
  }

  // tslint:disable-next-line:no-bitwise
  return stat.mode & 0o777;
}

export default class LocalFileSystem extends FileSystem {
  constructor(pathResolver: any) {
    super(pathResolver);
  }

  toFileStat(stat: fs.Stats): FileStats {
    return {
      type: FileSystem.getFileTypecharacter(stat),
      size: stat.size,
      mode: localMode(stat),
      mtime: stat.mtime.getTime(),
      atime: stat.atime.getTime(),
    };
  }

  lstat(path: string): Promise<FileStats> {
    return new Promise((resolve, reject) => {
      fs.lstat(path, (err, stat: fs.Stats) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(this.toFileStat(stat));
      });
    });
  }

  readFile(path, option?): Promise<string | Buffer> {
    return new Promise((resolve, reject) => {
      fs.readFile(path, option, (err, data) => {
        if (err) {
          return reject(err);
        }

        resolve(data);
      });
    });
  }

  open(path: string, flags: string, mode?: number): Promise<number> {
    return fse.open(path, flags, mode);
  }

  close(fd: number): Promise<void> {
    return fse.close(fd);
  }

  fstat(fd: number): Promise<FileStats> {
    return fse.fstat(fd).then(stat => this.toFileStat(stat));
  }

  futimes(fd: number, atime: number, mtime: number): Promise<void> {
    return fse.futimes(fd, atime, mtime);
  }

  utimes(path: string, atime: number, mtime: number): Promise<void> {
    return fse.utimes(path, atime, mtime);
  }

  get(path, option?): Promise<fs.ReadStream> {
    return new Promise((resolve, reject) => {
      try {
        const stream = fs.createReadStream(path, option);
        stream.once('error', reject);
        resolve(stream);
      } catch (err) {
        reject(err);
      }
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      fs.chmod(path, mode, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  put(input: fs.ReadStream, path, option?: FileOption): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (option && option.fd && typeof option.fd !== 'number') {
        return reject(new Error('fd is not a number'));
      }

      const writer = fs.createWriteStream(path, option as any);
      writer.once('error', reject).once('finish', resolve); // transffered

      input.once('error', err => {
        reject(err);
        writer.end();
      });
      input.pipe(writer);
    });
  }

  readlink(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      fs.readlink(path, (err, linkString) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(linkString);
      });
    });
  }

  symlink(targetPath: string, path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.symlink(targetPath, path, null, err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  mkdir(dir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.mkdir(dir, err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  ensureDir(dir: string): Promise<void> {
    return fse.ensureDir(dir);
  }

  toFileEntry(fullPath: string, stat: FileStats): FileEntry {
    return {
      fspath: fullPath,
      name: this.pathResolver.basename(fullPath),
      ...stat,
    };
  }

  list(dir: string): Promise<FileEntry[]> {
    return new Promise((resolve, reject) => {
      fs.readdir(dir, (err, files) => {
        if (err) {
          reject(err);
          return;
        }

        const fileStatus = files.map(file => {
          const fspath = this.pathResolver.join(dir, file);
          return this.lstat(fspath).then(stat =>
            this.toFileEntry(fspath, stat)
          );
        });

        resolve(Promise.all(fileStatus));
      });
    });
  }

  unlink(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.unlink(path, err => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  rmdir(path: string, recursive: boolean): Promise<void> {
    if (recursive) {
      return fse.remove(path);
    }

    return new Promise<void>((resolve, reject) => {
      fs.rmdir(path, err => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  rename(srcPath: string, destPath: string): Promise<void> {
    return fse.rename(srcPath, destPath);
  }

  renameAtomic(srcPath: string, destPath: string): Promise<void> {
    return fse.rename(srcPath, destPath);
  }
}
