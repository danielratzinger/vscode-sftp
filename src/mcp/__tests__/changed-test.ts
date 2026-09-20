jest.mock('fs');

import { vol } from 'memfs';
import { createTools, since, ToolContext } from '../tools';
import { ServiceLike } from '../exposure';
import { FileType } from '../../core/fs';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('since', () => {
  it('reads a window the way somebody says it', () => {
    expect(since('7d', NOW)).toBe(NOW - 7 * DAY);
    expect(since('48h', NOW)).toBe(NOW - 2 * DAY);
    expect(since('30m', NOW)).toBe(NOW - 30 * 60 * 1000);
    expect(since('2 weeks', NOW)).toBe(NOW - 14 * DAY);
  });

  it('takes a date, and a timestamp', () => {
    expect(since('2023-11-14', NOW)).toBe(Date.parse('2023-11-14'));
    expect(since(NOW - DAY, NOW)).toBe(NOW - DAY);
    expect(since(3, NOW)).toBe(NOW - 3 * DAY);
  });

  it('means no window rather than an error', () => {
    // A listing is still useful; refusing one over a typo is not.
    [undefined, null, '', '   ', 'last tuesday-ish', {}].forEach(value =>
      expect(since(value, NOW)).toBeUndefined()
    );
  });
});

const STAGING: ServiceLike = {
  id: 1,
  name: 'Staging',
  workspace: '/work/site',
  baseDir: '/work/site',
  getConfig: () => ({
    protocol: 'sftp',
    host: 'staging.example.com',
    port: 22,
    remotePath: '/srv/app',
  }),
};

const REAL_NOW = Date.now();
const FILES: Array<[string, number]> = [
  ['old.php', REAL_NOW - 400 * DAY],
  ['deployed.php', REAL_NOW - 2 * DAY],
  ['hotfix.php', REAL_NOW - 1 * DAY],
];

function createContext(): ToolContext {
  return {
    services: () => [STAGING],
    exposure: () => ({ exposedByDefault: true }),
    cacheOption: () => ({ cacheRoot: '/cache', materialize: false }),
    remoteFs: async () => ({
      list: async (dir: string) =>
        dir !== '/srv/app'
          ? []
          : FILES.map(([name, mtime]) => ({
              name,
              fspath: `/srv/app/${name}`,
              type: FileType.File,
              size: 10,
              mtime,
              atime: mtime,
              mode: 0o644,
            })),
      lstat: async () => ({ type: FileType.File, size: 10, mtime: NOW }),
      readFile: async () => '<?php',
    }),
  } as any;
}

const tree = () =>
  createTools(createContext()).find(t => t.name === 'tree')!;

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ '/cache/.keep': '' });
});

describe('what changed', () => {
  it('answers with the files a deploy touched, newest first', async () => {
    const result: any = await tree().run({ server: 'Staging', since: '7d' });

    expect(result.structured.files.map((f: any) => f.path)).toEqual([
      '/srv/app/hotfix.php',
      '/srv/app/deployed.php',
    ]);
    expect(result.text).toContain('changed since');
    // The time is what the question was about, so it is on every line.
    expect(result.text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it('says plainly when nothing changed', async () => {
    const result: any = await tree().run({ server: 'Staging', since: '1h' });

    expect(result.text).toContain('Nothing under /srv/app has changed');
    expect(result.structured.files).toEqual([]);
  });

  it('still lists everything when no window is given', async () => {
    const result: any = await tree().run({ server: 'Staging' });

    expect(result.structured.files).toHaveLength(3);
    // Listing order, untouched: only a window or an explicit sort reorders.
    expect(result.structured.files[0].path).toBe('/srv/app/old.php');
  });

  it('sorts by time without filtering when asked', async () => {
    const result: any = await tree().run({ server: 'Staging', sort: 'modified' });

    expect(result.structured.files.map((f: any) => f.path)).toEqual([
      '/srv/app/hotfix.php',
      '/srv/app/deployed.php',
      '/srv/app/old.php',
    ]);
  });

  it('ignores a window it cannot read, rather than refusing', async () => {
    const result: any = await tree().run({ server: 'Staging', since: 'recently' });

    expect(result.structured.files).toHaveLength(3);
  });
});
