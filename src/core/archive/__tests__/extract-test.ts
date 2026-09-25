jest.mock('fs');

import { Readable } from 'stream';
import { vol } from 'memfs';
import * as tar from 'tar';
import { entryTarget, extractInto, isArchiveRoot } from '../extract';

function archiveOf(files: { [path: string]: string }) {
  vol.reset();
  vol.fromJSON(files, '/remote');
  return tar.create(
    { gzip: true, cwd: '/remote', portable: true } as any,
    ['.']
  ) as any;
}

/** The same archive as bytes, for a test that hands them over itself. */
function archiveBytesOf(files: { [path: string]: string }): Buffer {
  vol.reset();
  vol.fromJSON(files, '/remote');
  return (tar.create(
    { gzip: true, cwd: '/remote', portable: true, sync: true } as any,
    ['.']
  ) as any).read() as Buffer;
}

function read(path: string): string {
  return vol.readFileSync(path, 'utf8') as string;
}

describe('where an entry is allowed to land', () => {
  it('drops the leading ./ tar puts on everything', () => {
    expect(entryTarget('/local', './app/boot.php')).toBe('/local/app/boot.php');
  });

  it('refuses a name that climbs out of the folder', () => {
    expect(entryTarget('/local', '../../etc/passwd')).toBeNull();
    expect(entryTarget('/local', './app/../../outside')).toBeNull();
  });

  it('refuses an absolute name, in either spelling', () => {
    expect(entryTarget('/local', '/etc/passwd')).toBeNull();
    expect(entryTarget('/local', 'C:\\windows\\system32')).toBeNull();
  });

  it('has nothing to do with the folder itself', () => {
    expect(entryTarget('/local', './')).toBeNull();
    expect(entryTarget('/local', '.')).toBeNull();
    // Refused and nothing-to-do both land nowhere, and only one is a warning.
    expect(isArchiveRoot('./')).toBe(true);
    expect(isArchiveRoot('.')).toBe(true);
    expect(isArchiveRoot('../outside')).toBe(false);
  });
});

describe('reading an archive into a folder', () => {
  it('writes the files it holds, folders and all', async () => {
    const source = archiveOf({
      'index.php': '<?php one',
      'app/boot.php': '<?php two',
      'app/views/head.php': '<?php three',
    });

    const result = await extractInto(source, { localBase: '/local' });

    expect(read('/local/index.php')).toBe('<?php one');
    expect(read('/local/app/views/head.php')).toBe('<?php three');
    expect(result.files).toBe(3);
  });

  it('leaves alone what the archive says nothing about', async () => {
    const source = archiveOf({ 'dir1/file2': 'from the server' });
    vol.mkdirSync('/local/dir1', { recursive: true });
    vol.writeFileSync('/local/dir1/file1', 'only here');

    await extractInto(source, { localBase: '/local' });

    expect(read('/local/dir1/file1')).toBe('only here');
    expect(read('/local/dir1/file2')).toBe('from the server');
  });

  it('writes over what it does say something about', async () => {
    const source = archiveOf({ 'index.php': 'new' });
    vol.mkdirSync('/local', { recursive: true });
    vol.writeFileSync('/local/index.php', 'old and longer');

    await extractInto(source, { localBase: '/local' });

    expect(read('/local/index.php')).toBe('new');
  });

  it('skips what the ignore rules skip, and says how many', async () => {
    const source = archiveOf({
      'index.php': 'kept',
      'debug.log': 'dropped',
      'app/other.log': 'dropped too',
    });

    const result = await extractInto(source, {
      localBase: '/local',
      ignore: fsPath => fsPath.endsWith('.log'),
    });

    expect(read('/local/index.php')).toBe('kept');
    expect(vol.existsSync('/local/debug.log')).toBe(false);
    expect(vol.existsSync('/local/app/other.log')).toBe(false);
    expect(result.files).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it('offers the file it is about to replace before replacing it', async () => {
    const source = archiveOf({ 'index.php': 'new' });
    vol.mkdirSync('/local', { recursive: true });
    vol.writeFileSync('/local/index.php', 'old');

    const seen: Array<{ path: string; content: string }> = [];
    await extractInto(source, {
      localBase: '/local',
      async keepReplaced(localPath) {
        seen.push({ path: localPath, content: read(localPath) });
      },
    });

    // Asked while the old content was still there, which is the whole point.
    expect(seen).toEqual([{ path: '/local/index.php', content: 'old' }]);
    expect(read('/local/index.php')).toBe('new');
  });

  it('asks the file filter about files, not about folders', async () => {
    const source = archiveOf({
      'app/boot.php': 'kept',
      'app/logo.png': 'dropped',
      'assets.png/style.css': 'kept too',
    });

    const asked: string[] = [];
    const result = await extractInto(source, {
      localBase: '/local',
      fileFilter: fsPath => {
        asked.push(fsPath);
        return !fsPath.endsWith('.png');
      },
    });

    expect(read('/local/app/boot.php')).toBe('kept');
    expect(vol.existsSync('/local/app/logo.png')).toBe(false);
    // A folder whose name ends in an excluded extension keeps its contents,
    // which is why the server is not told to exclude anything.
    expect(read('/local/assets.png/style.css')).toBe('kept too');
    expect(asked.some(p => p.endsWith('assets.png'))).toBe(false);
    expect(result.files).toBe(2);
  });

  it('counts an entry this machine will not write, and carries on', async () => {
    const source = archiveOf({ 'one.txt': 'first', 'two.txt': 'second' });
    // A folder where the first file has to go: the write fails, as an
    // unspellable name fails on Windows.
    vol.mkdirSync('/local/one.txt', { recursive: true });

    const result = await extractInto(source, { localBase: '/local' });

    expect(result.refused).toBe(1);
    expect(result.files).toBe(1);
    expect(read('/local/two.txt')).toBe('second');
  });

  it('fails when nothing at all could be written', async () => {
    const source = archiveOf({ 'one.txt': 'first' });
    vol.mkdirSync('/local/one.txt', { recursive: true });

    // Whatever is wrong is wrong with every entry, not with one of them.
    await expect(
      extractInto(source, { localBase: '/local' })
    ).rejects.toThrow(/nothing could be written/);
  });

  it('never holds back the stream the entries arrive through', async () => {
    // The invariant the hang broke. Pausing the source to wait for a write is
    // waiting for bytes that can only arrive through the source that was
    // paused - and whether it deadlocks or merely survives depends on whether
    // the pipe happens to resume it, which is not something to depend on.
    // Asserted structurally rather than by reproducing the race, which needs a
    // timing this test cannot pin down.
    const source = archiveOf({ 'index.php': 'one', 'app/boot.php': 'two' });
    const paused: string[] = [];
    const realPause = source.pause.bind(source);
    source.pause = (...args: any[]) => {
      paused.push('pause');
      return realPause(...args);
    };

    await extractInto(source, {
      localBase: '/local',
      keepReplaced: () => new Promise(done => setTimeout(done, 1)),
    });

    expect(paused).toEqual([]);
  });

  it('reads an archive that arrives in pieces, while a copy is being kept', async () => {
    // The shape that deadlocked: a file whose bytes span several reads from the
    // connection, with something slow to do before it can be written. Pausing
    // the source to wait for the write meant waiting for bytes that could only
    // arrive through the source that was paused.
    const big = 'x'.repeat(512 * 1024);
    vol.reset();
    vol.fromJSON({ 'big.txt': big, 'after.txt': 'second' }, '/remote');
    const bytes = (tar.create(
      { gzip: true, cwd: '/remote', portable: true, sync: true } as any,
      ['.']
    ) as any).read() as Buffer;

    // Handed over in small pieces, as a channel hands it over.
    let at = 0;
    const inPieces = new Readable({
      read() {
        if (at >= bytes.length) {
          this.push(null);
          return;
        }
        this.push(bytes.slice(at, at + 8 * 1024));
        at += 8 * 1024;
      },
    });

    const result = await extractInto(inPieces, {
      localBase: '/local',
      keepReplaced: () => new Promise(done => setTimeout(done, 1)),
    });

    expect(result.files).toBe(2);
    expect(read('/local/big.txt')).toHaveLength(big.length);
    expect(read('/local/after.txt')).toBe('second');
  });

  it('gives up on a stream that has gone quiet, rather than waiting for ever', async () => {
    // What the hang looked like from here: bytes stop, nothing fails, and the
    // only sign is a progress bar that never moves again.
    const silent = new Readable({ read: () => undefined });

    await expect(
      extractInto(silent, { localBase: '/local', stallAfter: 50 })
    ).rejects.toThrow(/reading the archive/);
  });

  it('waits as long as bytes keep arriving, however slowly', async () => {
    const bytes = archiveBytesOf({ 'one.txt': 'first' });
    let at = 0;
    const trickle = new Readable({
      read() {
        setTimeout(() => {
          if (at >= bytes.length) {
            this.push(null);
            return;
          }
          this.push(bytes.slice(at, at + 64));
          at += 64;
        }, 5);
      },
    });

    const result = await extractInto(trickle, {
      localBase: '/local',
      stallAfter: 100,
    });

    expect(result.files).toBe(1);
  });

  it('stops at once when the trouble is the disk and not the file', async () => {
    const source = archiveOf({ 'one.txt': 'first', 'two.txt': 'second' });
    const seen: string[] = [];

    // Every entry after this one would fail the same way. Carrying on turns one
    // condition into a warning per file and a folder of half-written ones.
    const full: any = new Error('ENOSPC: no space left on device');
    full.code = 'ENOSPC';

    const failed = await extractInto(source, {
      localBase: '/local',
      keepReplaced: async localPath => {
        seen.push(localPath);
        throw full;
      },
    }).catch(error => error);

    expect(failed.code).toBe('ENOSPC');
    expect(failed.noPointRetrying).toBe(true);
    // And it did not go on to the next one.
    expect(seen).toHaveLength(1);
  });

  it('stops when so many entries fail that it is about the place, not the files', async () => {
    const many: { [path: string]: string } = {};
    for (let i = 0; i < 40; i += 1) {
      many[`file${i}.txt`] = 'x';
    }
    const source = archiveOf(many);

    const refused: any = new Error('something the disk did not like');
    const failed = await extractInto(source, {
      localBase: '/local',
      keepReplaced: () => Promise.reject(refused),
    }).catch(error => error);

    expect(failed.message).toMatch(/entries could not be written/);
    expect(failed.noPointRetrying).toBe(true);
  });

  it('fails when the stream is not an archive at all', async () => {
    const { Readable } = require('stream');
    const rubbish = new Readable();
    rubbish.push(Buffer.from('this is not gzip'));
    rubbish.push(null);

    await expect(
      extractInto(rubbish, { localBase: '/local' })
    ).rejects.toBeDefined();
  });
});
