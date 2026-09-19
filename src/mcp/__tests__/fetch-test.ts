jest.mock('fs');

import { vol } from 'memfs';
import { createTools, ToolContext } from '../tools';
import { ServiceLike } from '../exposure';
import { FileType } from '../../core/fs';

const REMOTE_MTIME = 2000000;
const REMOTE = 'line one\nline two\nline three';

const STAGING: ServiceLike = {
  id: 1,
  name: 'Staging',
  workspace: '/work/site',
  baseDir: '/work/site',
  getConfig: () => ({
    name: 'Staging',
    protocol: 'sftp',
    host: 'staging.example.com',
    port: 22,
    remotePath: '/srv/app',
  }),
};

function place(files: { [key: string]: [string, number] }) {
  vol.reset();
  const contents: { [key: string]: string } = {};
  Object.keys(files).forEach(p => (contents[p] = files[p][0]));
  vol.fromJSON(Object.keys(contents).length ? contents : { '/work/site/.keep': '' });
  Object.keys(files).forEach(p => {
    const when = new Date(files[p][1]);
    vol.utimesSync(p, when, when);
  });
}

function createContext(over: Partial<ToolContext> = {}): ToolContext & { written: string[] } {
  const written: string[] = [];

  return {
    written,
    services: () => [STAGING],
    exposure: () => ({ exposedByDefault: true }),
    cacheOption: () => ({ cacheRoot: '/cache' }),
    onWorkspaceWrite: (p: string) => written.push(p),
    remoteFs: async () => ({
      list: async () => [],
      lstat: async () => ({
        type: FileType.File,
        size: Buffer.byteLength(REMOTE),
        mtime: REMOTE_MTIME,
      }),
      readFile: async () => REMOTE,
    }),
    ...over,
  } as any;
}

const tool = (context: ToolContext, name: string) =>
  createTools(context).find(t => t.name === name)!;

describe('sftp_fetch', () => {
  it('materialises an absent file into the project and returns it', async () => {
    place({});
    const context = createContext();

    const result = await tool(context, 'sftp_fetch').run({
      server: '1',
      path: '/srv/app/index.php',
    });

    expect(result.text).toBe(REMOTE);
    expect((result.structured as any).source).toBe('workspace');
    expect((result.structured as any).state).toBe('missing');
    expect((context as any).written).toEqual(['/work/site/index.php']);
  });

  it('serves the server version and flags a newer local copy', async () => {
    place({ '/work/site/index.php': ['my unsaved work', REMOTE_MTIME + 60000] });

    const result = await tool(createContext(), 'sftp_fetch').run({
      server: '1',
      path: '/srv/app/index.php',
    });

    // The default is always what is deployed, never the working copy.
    expect(result.text).toContain(REMOTE);
    expect(result.text).toContain('local copy is newer');
    expect(result.text).toContain('sftp_fetch_local');
    expect((result.structured as any).source).toBe('cache');
    expect((result.structured as any).state).toBe('newer');
  });

  it('leaves the working copy untouched when it diverges', async () => {
    place({ '/work/site/index.php': ['my unsaved work', REMOTE_MTIME + 60000] });

    await tool(createContext(), 'sftp_fetch').run({
      server: '1',
      path: '/srv/app/index.php',
    });

    expect(vol.readFileSync('/work/site/index.php', 'utf8')).toBe('my unsaved work');
  });

  it('returns a numbered range of a file', async () => {
    place({});

    const result = await tool(createContext(), 'sftp_fetch').run({
      server: '1',
      path: '/srv/app/index.php',
      start_line: 2,
      end_line: 3,
    });

    expect(result.text).toBe('2\tline two\n3\tline three');
  });

  it('refuses a directory and points at the right tool', async () => {
    place({});
    const context = createContext({
      remoteFs: async () => ({
        list: async () => [],
        lstat: async () => ({ type: FileType.Directory, size: 0, mtime: REMOTE_MTIME }),
        readFile: async () => '',
      }),
    });

    const result = await tool(context, 'sftp_fetch').run({
      server: '1',
      path: '/srv/app/src',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('sftp_list');
  });

  it('reports a path the server does not have', async () => {
    place({});
    const context = createContext({
      remoteFs: async () => ({
        list: async () => [],
        lstat: async () => {
          throw new Error('file not exist');
        },
        readFile: async () => '',
      }),
    });

    const result = await tool(context, 'sftp_fetch').run({
      server: '1',
      path: '/srv/app/gone.php',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not on the server');
  });

  it('stays out of the project when materialising is off', async () => {
    place({});
    const context = createContext({ cacheOption: () => ({ cacheRoot: '/cache', materialize: false }) });

    const result = await tool(context, 'sftp_fetch').run({
      server: '1',
      path: '/srv/app/index.php',
    });

    expect((result.structured as any).source).toBe('cache');
    expect((context as any).written).toEqual([]);
    expect(vol.existsSync('/work/site/index.php')).toBe(false);
  });

  it('treats a hidden server as absent', async () => {
    place({});
    const hidden = createContext({
      exposure: () => ({ exposedByDefault: false }),
    });

    const result = await tool(hidden, 'sftp_fetch').run({
      server: '1',
      path: '/srv/app/index.php',
    });

    expect(result.text).toBe('Unknown server.');
  });
});

describe('sftp_fetch_local', () => {
  it('returns the working copy, which sftp_fetch will not', async () => {
    place({ '/work/site/index.php': ['my unsaved work', REMOTE_MTIME + 60000] });

    const result = await tool(createContext(), 'sftp_fetch_local').run({
      server: '1',
      path: '/srv/app/index.php',
    });

    expect(result.text).toBe('my unsaved work');
    expect((result.structured as any).source).toBe('workspace');
  });

  it('says plainly when there is no local copy', async () => {
    place({});

    const result = await tool(createContext(), 'sftp_fetch_local').run({
      server: '1',
      path: '/srv/app/index.php',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('no local copy');
    expect(result.text).toContain('/work/site/index.php');
  });
});

describe('the redaction setting reaches the tools', () => {
  const SECRET = `define('DB_PASSWORD', 'Xk7#mQ2vL9pR');`;

  function withContent(over: Partial<ToolContext> = {}) {
    place({});
    return createContext({
      remoteFs: async () => ({
        list: async () => [],
        lstat: async () => ({
          type: FileType.File,
          size: Buffer.byteLength(SECRET),
          mtime: REMOTE_MTIME,
        }),
        readFile: async () => SECRET,
      }),
      ...over,
    });
  }

  it('redacts a named assignment by default', async () => {
    const result = await tool(withContent(), 'sftp_fetch').run({
      server: '1',
      path: '/srv/app/config.php',
      start_line: 1,
    });

    expect(result.text).not.toContain('Xk7#mQ2vL9pR');
  });

  it('leaves it alone when the setting says so', async () => {
    // The layer errs towards redacting, so there has to be a way back.
    const context = withContent({ redaction: () => ({ assignments: false }) });

    const result = await tool(context, 'sftp_fetch').run({
      server: '1',
      path: '/srv/app/config.php',
      start_line: 1,
    });

    expect(result.text).toContain('Xk7#mQ2vL9pR');
  });
});

describe('what lands on disk is never redacted', () => {
  // The property this protects: the copy in the project is the one that gets
  // edited in the editor and uploaded by hand. A redacted byte in it would
  // replace a live credential the next time the user saves.
  const SECRET_FILE = [
    `define('DB_PASSWORD', 'Xk7#mQ2vL9pR');`,
    'const key = "AKIAIOSFODNN7EXAMPLE";',
  ].join('\n');

  function serving(content: string) {
    return createContext({
      remoteFs: async () => ({
        list: async () => [
          {
            name: 'config.php',
            fspath: '/srv/app/config.php',
            type: FileType.File,
            size: Buffer.byteLength(content),
            mtime: REMOTE_MTIME,
            atime: REMOTE_MTIME,
            mode: 0o644,
          },
        ],
        lstat: async () => ({
          type: FileType.File,
          size: Buffer.byteLength(content),
          mtime: REMOTE_MTIME,
        }),
        readFile: async () => content,
      }),
    });
  }

  it('writes the server\u2019s bytes into the project, credentials and all', async () => {
    place({});
    const context = serving(SECRET_FILE);

    const result = await tool(context, 'sftp_fetch').run({
      server: '1',
      path: '/srv/app/config.php',
      start_line: 1,
    });

    // Redacted on the way out...
    expect(result.text).not.toContain('Xk7#mQ2vL9pR');
    // ...and untouched on disk, byte for byte.
    expect(vol.readFileSync('/work/site/config.php', 'utf8')).toBe(SECRET_FILE);
  });

  it('leaves the file alone when a search reads it', async () => {
    place({});
    const context = serving(SECRET_FILE);

    const result = await tool(context, 'sftp_search').run({
      server: '1',
      query: 'DB_PASSWORD',
    });

    expect(result.text).not.toContain('Xk7#mQ2vL9pR');
    expect(vol.readFileSync('/work/site/config.php', 'utf8')).toBe(SECRET_FILE);
  });

  it('does not redact a copy the user already had', async () => {
    const MINE = `define('DB_PASSWORD', 'Xk7#mQ2vL9pR'); // my edit`;
    place({ '/work/site/config.php': [MINE, REMOTE_MTIME + 60000] });

    await tool(serving(SECRET_FILE), 'sftp_fetch').run({
      server: '1',
      path: '/srv/app/config.php',
      start_line: 1,
    });

    // A newer local copy is not overwritten at all - and certainly not with
    // markers where its credentials were.
    expect(vol.readFileSync('/work/site/config.php', 'utf8')).toBe(MINE);
  });
});

describe('the connection is a boundary, not a starting point', () => {
  // A path argument decides both what is read from the server and where it is
  // written here. Unchecked, `..` walks out of the exposed directory in both
  // directions at once.
  const OUTSIDE = [
    '/etc/passwd',
    '/srv/app/../../etc/passwd',
    '/srv/other-client/wp-includes/db.php',
  ];

  OUTSIDE.forEach(candidate => {
    it(`refuses ${candidate} and writes nothing`, async () => {
      place({});
      const context = createContext();

      const result = await tool(context, 'sftp_fetch').run({
        server: '1',
        path: candidate,
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('outside /srv/app');
      expect(Object.keys(vol.toJSON())).toEqual(['/work/site/.keep']);
      expect(context.written).toEqual([]);
    });
  });

  it('refuses one for every tool that takes a path', async () => {
    place({});
    const context = createContext();
    const outside = { server: '1', path: '/etc/passwd' };

    const results = await Promise.all([
      tool(context, 'sftp_stat').run(outside),
      tool(context, 'sftp_fetch_local').run(outside),
      tool(context, 'sftp_list').run(outside),
      tool(context, 'sftp_note').run({ ...outside, summary: 'x' }),
      tool(context, 'sftp_forget').run(outside),
      tool(context, 'sftp_search').run({ server: '1', query: 'x', dir: '/etc' }),
      tool(context, 'sftp_tree').run({ server: '1', dir: '/etc' }),
    ]);

    results.forEach(result => {
      expect(result.isError).toBe(true);
      expect(result.text).toContain('outside /srv/app');
    });
  });

  it('accepts the same file however it is spelled', async () => {
    place({});
    const result = await tool(createContext(), 'sftp_stat').run({
      server: '1',
      path: '/srv/app//./config.php',
    });

    expect(result.isError).toBeUndefined();
    expect((result.structured as any).path).toBe('/srv/app/config.php');
  });
});

describe('what is too big or not text', () => {
  function serving(content: string | Buffer, size?: number) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    return createContext({
      remoteFs: async () => ({
        list: async () => [
          {
            name: 'dump.sql',
            fspath: '/srv/app/dump.sql',
            type: FileType.File,
            size: size === undefined ? bytes.length : size,
            mtime: REMOTE_MTIME,
            atime: REMOTE_MTIME,
            mode: 0o644,
          },
        ],
        lstat: async () => ({
          type: FileType.File,
          size: size === undefined ? bytes.length : size,
          mtime: REMOTE_MTIME,
        }),
        readFile: async () => bytes,
      }),
    });
  }

  it('refuses a file over the limit without fetching it', async () => {
    place({});
    const context = serving('small on disk, huge on paper', 50 * 1024 * 1024);

    const result = await tool(context, 'sftp_fetch').run({
      server: '1',
      path: '/srv/app/dump.sql',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('50 MB');
    expect(result.text).toContain('sftp.mcp.maxFileBytes');
    // Nothing was pulled across the wire, and nothing landed on disk.
    expect(vol.existsSync('/work/site/dump.sql')).toBe(false);
  });

  it('honours a raised limit', async () => {
    place({});
    const context = serving('text', 3 * 1024 * 1024);
    (context as any).maxFileBytes = () => 8 * 1024 * 1024;

    const result = await tool(context, 'sftp_fetch').run({
      server: '1',
      path: '/srv/app/dump.sql',
      start_line: 1,
    });

    expect(result.isError).toBeUndefined();
  });

  it('says a binary file is not text instead of returning mojibake', async () => {
    place({});
    const context = serving(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]));

    const result = await tool(context, 'sftp_fetch').run({
      server: '1',
      path: '/srv/app/dump.sql',
      start_line: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not a text file');
    // It is still on disk: something else may be able to use it.
    expect(vol.existsSync('/work/site/dump.sql')).toBe(true);
  });

  it('skips both kinds during a search and says how many', async () => {
    place({});
    const context = serving(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));

    const result = await tool(context, 'sftp_search').run({
      server: '1',
      query: 'anything',
    });

    expect(result.text).toContain('1 file was skipped');
  });
});

describe('a search that runs out of time', () => {
  const FILES = ['one.php', 'two.php', 'three.php'];
  const CONTENT = '<?php // the needle is here';

  function slowContext(perFileMs: number, callTimeout: number) {
    return createContext({
      callTimeout: () => callTimeout,
      remoteFs: async () => ({
        list: async () =>
          FILES.map(name => ({
            name,
            fspath: `/srv/app/${name}`,
            type: FileType.File,
            size: Buffer.byteLength(CONTENT),
            mtime: REMOTE_MTIME,
            atime: REMOTE_MTIME,
            mode: 0o644,
          })),
        lstat: async () => ({
          type: FileType.File,
          size: Buffer.byteLength(CONTENT),
          mtime: REMOTE_MTIME,
        }),
        readFile: async () => {
          await new Promise(done => setTimeout(done, perFileMs));
          return CONTENT;
        },
      }),
    } as any);
  }

  it('returns what it found instead of an error', async () => {
    place({});

    const result = await tool(slowContext(60, 40), 'sftp_search').run({
      server: '1',
      query: 'needle',
    });

    // Partial results answer the question better than a failure does.
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('ran out of time');
    expect(result.text).toContain('needle is here');
    expect((result.structured as any).scanned).toBe(1);
  });

  it('says nothing about time when there was enough of it', async () => {
    place({});

    const result = await tool(slowContext(0, 5000), 'sftp_search').run({
      server: '1',
      query: 'needle',
    });

    expect(result.text).not.toContain('ran out of time');
    expect((result.structured as any).scanned).toBe(3);
  });
});
