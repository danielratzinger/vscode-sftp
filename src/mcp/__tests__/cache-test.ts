jest.mock('fs');

import { vol } from 'memfs';
import * as fse from 'fs-extra';
import {
  cachePathFor,
  compare,
  LocalState,
  materialise,
  pruneCache,
  resolve,
} from '../cache';

const OPTION = { cacheRoot: '/cache' };
const REMOTE_MTIME = 2000000;

const input = (over: any = {}) => ({
  connectionId: '1',
  remotePath: '/srv/app/index.php',
  localPath: '/work/site/index.php',
  remote: { size: 15, mtime: REMOTE_MTIME },
  option: OPTION,
  ...over,
});

function place(files: { [key: string]: [string, number] }) {
  vol.reset();
  const contents: { [key: string]: string } = {};
  Object.keys(files).forEach(p => (contents[p] = files[p][0]));
  vol.fromJSON(contents);
  Object.keys(files).forEach(p => {
    const when = new Date(files[p][1]);
    vol.utimesSync(p, when, when);
  });
}

const writer = (bytes = 'remote contents') => {
  const written: string[] = [];
  return {
    written,
    read: async () => Buffer.from(bytes),
    onWorkspaceWrite: (p: string) => written.push(p),
  };
};

describe('compare', () => {
  it('classifies the four states', () => {
    expect(compare(undefined, { size: 1, mtime: 1000 })).toBe(LocalState.Missing);
    expect(compare({ size: 1, mtime: 1000 }, { size: 1, mtime: 1000 })).toBe(LocalState.Same);
    expect(compare({ size: 1, mtime: 500 }, { size: 1, mtime: 2000 })).toBe(LocalState.Older);
    expect(compare({ size: 1, mtime: 3000 }, { size: 1, mtime: 2000 })).toBe(LocalState.Newer);
  });

  it('ignores sub-second differences', () => {
    expect(compare({ size: 1, mtime: 2000400 }, { size: 1, mtime: 2000000 })).toBe(
      LocalState.Same
    );
  });

  it('treats the same second with a different size as ours being ahead', () => {
    expect(compare({ size: 9, mtime: 2000400 }, { size: 1, mtime: 2000000 })).toBe(
      LocalState.Newer
    );
  });
});

describe('cachePathFor', () => {
  it('mirrors the remote layout under the connection', () => {
    expect(cachePathFor(OPTION, '1', '/srv/app/index.php')).toBe(
      '/cache/1/srv/app/index.php'
    );
  });

  it('keeps two connections apart', () => {
    expect(cachePathFor(OPTION, '1', '/a')).not.toBe(cachePathFor(OPTION, '2', '/a'));
  });
});

describe('resolve', () => {
  it('sends an absent file to the workspace', async () => {
    place({});
    const result = await resolve(input());

    expect(result.state).toBe(LocalState.Missing);
    expect(result.source).toBe('workspace');
  });

  it('leaves an identical file where it is', async () => {
    place({ '/work/site/index.php': ['x'.repeat(15), REMOTE_MTIME] });
    const result = await resolve(input());

    expect(result.state).toBe(LocalState.Same);
    expect(result.source).toBe('workspace');
  });

  it('diverts a file with local edits to the cache', async () => {
    place({ '/work/site/index.php': ['edited', REMOTE_MTIME + 60000] });
    const result = await resolve(input());

    expect(result.state).toBe(LocalState.Newer);
    expect(result.source).toBe('cache');
  });

  it('diverts an older file to the cache rather than overwriting it', async () => {
    // The server moved on, but this is still a file the user has; changing it
    // as a side effect of a question is not ours to do.
    place({ '/work/site/index.php': ['stale', REMOTE_MTIME - 60000] });
    const result = await resolve(input());

    expect(result.state).toBe(LocalState.Older);
    expect(result.source).toBe('cache');
  });

  it('keeps out of the workspace entirely when told to', async () => {
    place({});
    const result = await resolve(
      input({ option: { ...OPTION, materialize: false } })
    );

    expect(result.state).toBe(LocalState.Missing);
    expect(result.source).toBe('cache');
  });
});

describe('materialise', () => {
  it('writes an absent file into the project and reports it', async () => {
    place({});
    const w = writer();

    const result = await materialise(input(), w);

    expect(result.contentPath).toBe('/work/site/index.php');
    expect(result.written).toBe(true);
    expect(await fse.readFile('/work/site/index.php', 'utf8')).toBe('remote contents');
    // The watcher must be told, or autoUpload sends it straight back.
    expect(w.written).toEqual(['/work/site/index.php']);
  });

  it('stamps the server timestamp so the next look reads "same"', async () => {
    place({});
    await materialise(input(), writer());

    const again = await resolve(input());
    expect(again.state).toBe(LocalState.Same);
  });

  it('writes nothing when the copies already agree', async () => {
    place({ '/work/site/index.php': ['x'.repeat(15), REMOTE_MTIME] });
    const w = writer();

    const result = await materialise(input(), w);

    expect(result.written).toBe(false);
    expect(w.written).toEqual([]);
  });

  it('never touches a file with local edits', async () => {
    place({ '/work/site/index.php': ['my unsaved work', REMOTE_MTIME + 60000] });

    const result = await materialise(input(), writer());

    expect(result.contentPath).toBe('/cache/1/srv/app/index.php');
    expect(await fse.readFile('/work/site/index.php', 'utf8')).toBe('my unsaved work');
    expect(await fse.readFile(result.contentPath, 'utf8')).toBe('remote contents');
  });

  it('reuses a cache entry fetched at the same version', async () => {
    place({ '/work/site/index.php': ['edited', REMOTE_MTIME + 60000] });

    const first = await materialise(input(), writer('first fetch'));
    expect(first.written).toBe(true);

    const second = await materialise(input(), writer('should not be read'));
    expect(second.written).toBe(false);
    expect(await fse.readFile(second.contentPath, 'utf8')).toBe('first fetch');
  });

  it('re-fetches when the server has moved on', async () => {
    place({ '/work/site/index.php': ['edited', REMOTE_MTIME + 60000] });
    await materialise(input(), writer('old version'));

    const later = await materialise(
      input({ remote: { size: 11, mtime: REMOTE_MTIME + 120000 } }),
      writer('new version')
    );

    expect(later.written).toBe(true);
    expect(await fse.readFile(later.contentPath, 'utf8')).toBe('new version');
  });
});

describe('pruneCache', () => {
  const option = { cacheRoot: '/cache' };

  beforeEach(() => {
    vol.reset();
    vol.fromJSON({
      '/cache/1/srv/app/index.php': 'a',
      '/cache/1/srv/app/old/gone.php': 'b',
      '/cache/1/srv/app/src/Kernel.php': 'c',
      '/cache/2/srv/app/index.php': 'other connection',
    });
  });

  it('removes what the server no longer has, and nothing else', async () => {
    const removed = await pruneCache(option, '1', p => p !== '/srv/app/old/gone.php');

    expect(removed).toEqual(['/srv/app/old/gone.php']);
    expect(vol.existsSync('/cache/1/srv/app/index.php')).toBe(true);
    expect(vol.existsSync('/cache/1/srv/app/src/Kernel.php')).toBe(true);
  });

  it('clears up the directory it emptied', async () => {
    await pruneCache(option, '1', p => p !== '/srv/app/old/gone.php');

    expect(vol.existsSync('/cache/1/srv/app/old')).toBe(false);
    expect(vol.existsSync('/cache/1/srv/app')).toBe(true);
  });

  it('never reaches into another connection', async () => {
    await pruneCache(option, '1', () => false);

    expect(vol.existsSync('/cache/2/srv/app/index.php')).toBe(true);
  });

  it('says nothing happened when a connection has no cache', async () => {
    expect(await pruneCache(option, '99', () => false)).toEqual([]);
  });
});

describe('two calls for the same file at once', () => {
  beforeEach(() => {
    vol.reset();
    vol.fromJSON({ '/work/site/.keep': '' });
  });

  const same = {
    connectionId: '1',
    remotePath: '/srv/app/index.php',
    localPath: '/work/site/index.php',
    remote: { size: 5, mtime: 2000000 },
    option: { cacheRoot: '/cache' },
  };

  it('fetches once and hands both callers the finished file', async () => {
    let reads = 0;
    const once = {
      read: async () => {
        reads += 1;
        // A real transfer is not instantaneous; this is where the second
        // caller used to read a half-written file.
        await new Promise(done => setTimeout(done, 10));
        return Buffer.from('hello');
      },
    };

    const [first, second] = await Promise.all([
      materialise(same, once),
      materialise(same, once),
    ]);

    expect(reads).toBe(1);
    expect(vol.readFileSync('/work/site/index.php', 'utf8')).toBe('hello');
    expect(first.contentPath).toBe('/work/site/index.php');
    expect(second.contentPath).toBe('/work/site/index.php');
  });

  it('does not let one failure poison the next caller', async () => {
    let attempt = 0;
    const flaky = {
      read: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('connection lost');
        }
        return Buffer.from('hello');
      },
    };

    const results = await Promise.all([
      materialise(same, flaky).catch(error => error.message),
      materialise(same, flaky).catch(error => error.message),
    ]);

    // One of them failed; the other got the file.
    expect(results).toContain('connection lost');
    expect(vol.readFileSync('/work/site/index.php', 'utf8')).toBe('hello');
  });

  it('does not queue different files behind each other', async () => {
    const order: string[] = [];
    const slow = (name: string, delay: number) => ({
      read: async () => {
        await new Promise(done => setTimeout(done, delay));
        order.push(name);
        return Buffer.from('x');
      },
    });

    await Promise.all([
      materialise({ ...same, remotePath: '/srv/app/slow.php', localPath: '/work/site/slow.php' }, slow('slow', 20)),
      materialise({ ...same, remotePath: '/srv/app/fast.php', localPath: '/work/site/fast.php' }, slow('fast', 1)),
    ]);

    expect(order).toEqual(['fast', 'slow']);
  });
});
