jest.mock('fs');

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
