jest.mock('fs');

import { vol } from 'memfs';
import { createTools, ToolContext } from '../tools';
import { ServiceLike } from '../exposure';
import { FileType } from '../../core/fs';
import { DEFAULT_WALK, searchPaths, searchText, walk } from '../search';

const MTIME = 2000000;

const STAGING: ServiceLike = {
  id: 1,
  name: 'Staging',
  workspace: '/work/site',
  baseDir: '/work/site',
  getConfig: () => ({
    name: 'Staging', protocol: 'sftp', host: 'h', port: 22, remotePath: '/srv/app',
  }),
};

/** A tiny server: a tree of files with contents. */
const SERVER: { [path: string]: string } = {
  '/srv/app/index.php': '<?php\nsession_start();\nrequire "boot.php";',
  '/srv/app/src/Session.php': '<?php\nclass Session {\n  function validate() {}\n}',
  '/srv/app/src/logo.png': 'binary junk',
  '/srv/app/.env': 'DB_PASSWORD=hunter2',
  '/srv/app/node_modules/dep/index.js': 'module.exports = 1;',
};

function entriesOf(dir: string) {
  const children = new Map<string, any>();

  Object.keys(SERVER).forEach(path => {
    if (path.indexOf(dir + '/') !== 0) return;
    const rest = path.slice(dir.length + 1);
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    const fspath = `${dir}/${name}`;
    children.set(name, {
      name,
      fspath,
      type: slash === -1 ? FileType.File : FileType.Directory,
      size: slash === -1 ? SERVER[path].length : 0,
      mtime: MTIME,
      atime: MTIME,
      mode: 0o644,
    });
  });

  return Array.from(children.values());
}

function createContext(over: Partial<ToolContext> = {}): ToolContext {
  return {
    services: () => [STAGING],
    exposure: () => ({ exposedByDefault: true }),
    cacheOption: () => ({ cacheRoot: '/cache', materialize: false }),
    remoteFs: async () => ({
      list: async (dir: string) => entriesOf(dir),
      lstat: async (p: string) => ({
        type: FileType.File, size: SERVER[p].length, mtime: MTIME,
      }),
      readFile: async (p: string) => SERVER[p],
    }),
    ...over,
  } as any;
}

const tool = (context: ToolContext, name: string) =>
  createTools(context).find(t => t.name === name)!;

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ '/work/site/.keep': '' });
});

describe('walk', () => {
  it('collects text files from the remote listing', async () => {
    const result = await walk(async dir => entriesOf(dir), '/srv/app', DEFAULT_WALK);
    const paths = result.files.map(f => f.path).sort();

    expect(paths).toContain('/srv/app/index.php');
    expect(paths).toContain('/srv/app/src/Session.php');
  });

  it('leaves out binaries and credential files', async () => {
    const result = await walk(async dir => entriesOf(dir), '/srv/app', DEFAULT_WALK);
    const paths = result.files.map(f => f.path);

    expect(paths).not.toContain('/srv/app/src/logo.png');
    // Never indexed, so a search can never leak it.
    expect(paths).not.toContain('/srv/app/.env');
  });

  it('skips the folders it is told to', async () => {
    const result = await walk(async dir => entriesOf(dir), '/srv/app', {
      ...DEFAULT_WALK,
      excludeFolders: ['node_modules'],
    });

    expect(result.files.map(f => f.path).join()).not.toContain('node_modules');
  });

  it('stops at its limits and says so', async () => {
    const result = await walk(async dir => entriesOf(dir), '/srv/app', {
      ...DEFAULT_WALK,
      maxFiles: 1,
    });

    expect(result.truncated).toBe(true);
    expect(result.files.length).toBeLessThanOrEqual(1);
  });

  it('carries on past a directory it cannot read', async () => {
    const result = await walk(
      async dir => {
        if (dir.indexOf('/src') !== -1) throw new Error('permission denied');
        return entriesOf(dir);
      },
      '/srv/app',
      DEFAULT_WALK
    );

    expect(result.files.map(f => f.path)).toContain('/srv/app/index.php');
  });
});

describe('searchText', () => {
  const option = { query: 'session', maxMatches: 30, maxPerFile: 3, context: 0 };

  it('finds a literal, ignoring case', () => {
    const matches = searchText('/a.php', 'nothing\nSESSION_START\nmore', option);

    expect(matches).toHaveLength(1);
    expect(matches[0].line).toBe(2);
  });

  it('returns context lines when asked', () => {
    const matches = searchText('/a.php', 'one\ntwo session\nthree', {
      ...option, context: 1,
    });

    expect(matches[0].before).toEqual(['one']);
    expect(matches[0].after).toEqual(['three']);
  });

  it('caps matches per file', () => {
    const many = Array(10).fill('session').join('\n');
    expect(searchText('/a.php', many, { ...option, maxPerFile: 2 })).toHaveLength(2);
  });

  it('explains a bad pattern rather than throwing something opaque', () => {
    expect(() =>
      searchText('/a.php', 'x', { ...option, query: '([', regex: true })
    ).toThrow(/not a valid pattern/);
  });
});

describe('searchPaths', () => {
  const files = [
    { path: '/srv/app/src/UserModel.php', size: 1, mtime: 1 },
    { path: '/srv/app/index.php', size: 1, mtime: 1 },
  ];

  it('matches on a substring of the path', () => {
    expect(searchPaths(files, 'usermodel').map(f => f.path)).toEqual([
      '/srv/app/src/UserModel.php',
    ]);
  });

  it('matches a glob', () => {
    expect(searchPaths(files, '*model*.php')).toHaveLength(1);
  });
});

describe('sftp_search', () => {
  it('finds text and says what it cost', async () => {
    const result = await tool(createContext(), 'sftp_search').run({
      server: '1',
      query: 'session_start',
    });

    expect(result.text).toContain('/srv/app/index.php:2');
    expect(result.text).toContain('files searched');
    expect((result.structured as any).matches[0].line).toBe(2);
  });

  it('reports path matches alongside content matches', async () => {
    const result = await tool(createContext(), 'sftp_search').run({
      server: '1',
      query: 'Session',
    });

    expect((result.structured as any).paths).toContain('/srv/app/src/Session.php');
  });

  it('never searches a credential file', async () => {
    const result = await tool(createContext(), 'sftp_search').run({
      server: '1',
      query: 'DB_PASSWORD',
    });

    // .env is excluded from the manifest entirely, so there is nothing to leak.
    expect(result.text).not.toContain('hunter2');
    expect((result.structured as any).matches).toHaveLength(0);
  });

  it('scopes to a directory', async () => {
    const result = await tool(createContext(), 'sftp_search').run({
      server: '1',
      query: 'class',
      dir: '/srv/app/src',
    });

    expect(result.text).toContain('/srv/app/src');
    expect((result.structured as any).matches[0].path).toBe('/srv/app/src/Session.php');
  });

  it('requires a query, and an exposed server', async () => {
    expect((await tool(createContext(), 'sftp_search').run({ server: '1' })).isError).toBe(true);
    expect(
      (await tool(createContext(), 'sftp_search').run({ server: '9', query: 'x' })).text
    ).toBe('Unknown server.');
  });
});

describe('a walk that runs out of time', () => {
  const tree: { [dir: string]: any[] } = {
    '/srv': [
      { name: 'a', fspath: '/srv/a', type: FileType.Directory, size: 0, mtime: 0 },
      { name: 'b', fspath: '/srv/b', type: FileType.Directory, size: 0, mtime: 0 },
    ],
    '/srv/a': [
      { name: 'one.php', fspath: '/srv/a/one.php', type: FileType.File, size: 1, mtime: 0 },
    ],
    '/srv/b': [
      { name: 'two.php', fspath: '/srv/b/two.php', type: FileType.File, size: 1, mtime: 0 },
    ],
  };

  it('stops where it is and says so', async () => {
    let listings = 0;
    const result = await walk(
      async (dir: string) => {
        listings += 1;
        return tree[dir] || [];
      },
      '/srv',
      {
        ...DEFAULT_WALK,
        excludeExtensions: [],
        // Out of time after the root and the first subdirectory.
        stopWhen: () => listings >= 2,
      }
    );

    expect(result.truncated).toBe(true);
    expect(result.files.map(f => f.path)).toEqual(['/srv/a/one.php']);
  });

  it('walks it all when there is time', async () => {
    const result = await walk(
      async (dir: string) => tree[dir] || [],
      '/srv',
      { ...DEFAULT_WALK, excludeExtensions: [], stopWhen: () => false }
    );

    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(2);
  });
});
