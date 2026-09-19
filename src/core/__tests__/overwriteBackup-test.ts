jest.mock('fs');

import { vol } from 'memfs';
import {
  backupRootFrom,
  backupsFor,
  keepReplaced,
  mirrorFor,
  pruneBackups,
  readBackup,
  restoreBackup,
} from '../overwriteBackup';

const option = {
  root: '/storage/replaced',
  connectionId: '1',
  keepPerFile: 3,
  maxAgeDays: 30,
};

const LOCAL = '/work/site/index.php';
const NOW = 1_700_000_000_000;

function place(content: string, mtime: number) {
  vol.reset();
  vol.fromJSON({ [LOCAL]: content });
  const when = new Date(mtime);
  vol.utimesSync(LOCAL, when, when);
}

describe('mirrorFor', () => {
  it('mirrors the path, so the store reads like the project', () => {
    expect(mirrorFor(option, LOCAL)).toBe('/storage/replaced/1/work/site/index.php');
  });

  it('copes with a Windows path', () => {
    expect(mirrorFor(option, 'C:\\work\\site\\index.php')).toBe(
      '/storage/replaced/1/C_/work/site/index.php'
    );
  });

  it('cannot be walked out of', () => {
    expect(mirrorFor(option, '/work/../../etc/passwd')).toBe(
      '/storage/replaced/1/work/etc/passwd'
    );
  });
});

describe('backupRootFrom', () => {
  it('sits under the extension\u2019s own storage', () => {
    expect(backupRootFrom('/storage')).toBe('/storage/replaced');
  });
});

describe('keepReplaced', () => {
  it('keeps a copy of work that is about to be overwritten', async () => {
    place('my unsaved changes', NOW - 60000);

    const backup = await keepReplaced(
      option,
      LOCAL,
      { size: 999, mtime: NOW },
      NOW
    );

    expect(backup).toBeDefined();
    expect(await readBackup(backup!)).toBe('my unsaved changes');
    expect(backup!.path).toBe('/storage/replaced/1/work/site/index.php/1700000000000.php');
  });

  it('keeps nothing when the file already matches what is arriving', async () => {
    // Most of a folder download is this, and copying it all would double
    // every download for no gain.
    const content = 'identical';
    place(content, NOW);

    const backup = await keepReplaced(
      option,
      LOCAL,
      { size: content.length, mtime: NOW },
      NOW
    );

    expect(backup).toBeUndefined();
  });

  it('keeps a copy when only the contents differ', async () => {
    place('same length!!', NOW);

    const backup = await keepReplaced(
      option,
      LOCAL,
      { size: 13, mtime: NOW - 120000 },
      NOW
    );

    expect(backup).toBeDefined();
  });

  it('keeps nothing when there is no file to lose', async () => {
    vol.reset();
    vol.fromJSON({ '/work/site/.keep': '' });

    expect(
      await keepReplaced(option, LOCAL, { size: 10, mtime: NOW }, NOW)
    ).toBeUndefined();
  });

  it('keeps a copy when the size of what is arriving is unknown', async () => {
    place('something', NOW);

    expect(
      await keepReplaced(option, LOCAL, { mtime: NOW }, NOW)
    ).toBeDefined();
  });
});

describe('backupsFor', () => {
  it('lists the copies of one file, newest first', async () => {
    place('one', NOW - 3000);
    await keepReplaced(option, LOCAL, { mtime: NOW }, NOW - 3000);
    // Not place(), which resets the volume and would wipe the store with it.
    vol.writeFileSync(LOCAL, 'two');
    await keepReplaced(option, LOCAL, { mtime: NOW }, NOW - 2000);

    const backups = await backupsFor(option, LOCAL);

    expect(backups.map(b => b.timestamp)).toEqual([NOW - 2000, NOW - 3000]);
    expect(await readBackup(backups[0])).toBe('two');
  });

  it('says nothing about a file that was never overwritten', async () => {
    place('untouched', NOW);

    expect(await backupsFor(option, LOCAL)).toEqual([]);
  });
});

describe('restoreBackup', () => {
  it('puts a copy back, keeping what it replaced', async () => {
    place('the version I want back', NOW - 5000);
    const backup = (await keepReplaced(option, LOCAL, { mtime: NOW }, NOW - 5000))!;

    vol.writeFileSync(LOCAL, 'what the download left');

    await restoreBackup(option, backup, NOW);

    expect(vol.readFileSync(LOCAL, 'utf8')).toBe('the version I want back');
    // Restoring the wrong version is not the end of the story.
    const after = await backupsFor(option, LOCAL);
    expect(after).toHaveLength(2);
    expect(await readBackup(after[0])).toBe('what the download left');
  });
});

describe('pruneBackups', () => {
  async function fill(count: number, spacingMs: number) {
    vol.reset();
    vol.fromJSON({ [LOCAL]: 'x' });
    for (let i = 0; i < count; i += 1) {
      vol.writeFileSync(LOCAL, `version ${i}`);
      await keepReplaced(option, LOCAL, { mtime: NOW }, NOW - (count - i) * spacingMs);
    }
  }

  it('keeps only the most recent few of one file', async () => {
    await fill(6, 1000);

    const result = await pruneBackups(option, NOW);

    expect(result.removed).toHaveLength(3);
    expect(await backupsFor(option, LOCAL)).toHaveLength(3);
  });

  it('drops anything older than the limit, however few there are', async () => {
    await fill(2, 40 * 24 * 60 * 60 * 1000);

    await pruneBackups(option, NOW);

    expect(await backupsFor(option, LOCAL)).toHaveLength(0);
  });

  it('clears up the directories it emptied', async () => {
    await fill(1, 40 * 24 * 60 * 60 * 1000);

    await pruneBackups(option, NOW);

    expect(vol.existsSync('/storage/replaced/1/work/site/index.php')).toBe(false);
  });

  it('is untroubled by a connection that has no backups', async () => {
    vol.reset();
    vol.fromJSON({ '/storage/.keep': '' });

    expect((await pruneBackups(option, NOW)).removed).toEqual([]);
  });
});
