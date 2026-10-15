import { createTools, localPathFor, ToolContext } from '../tools';
import { ServiceLike, UNKNOWN_SERVER } from '../exposure';
import { FileType } from '../../core/fs';

function service(id: number, config: any): ServiceLike {
  return {
    id,
    name: config.name || config.host,
    workspace: '/work/site',
    baseDir: '/work/site',
    getConfig: () => config,
  };
}

const STAGING = service(1, {
  name: 'Staging',
  protocol: 'sftp',
  host: 'staging.example.com',
  port: 22,
  username: 'deploy',
  remotePath: '/srv/app',
});

const HIDDEN = service(2, {
  name: 'Production',
  protocol: 'ftp',
  host: 'example.com',
  port: 21,
  remotePath: '/www',
  mcp: { exposed: false },
});

const entry = (name: string, type: FileType, size = 10, mtime = 1000) => ({
  name,
  fspath: `/srv/app/${name}`,
  type,
  size,
  mtime,
  atime: mtime,
  mode: 0o644,
});

function createContext(over: Partial<ToolContext> = {}): ToolContext {
  return {
    services: () => [STAGING, HIDDEN],
    exposure: () => ({ exposedByDefault: true }),
    cacheOption: () => ({ cacheRoot: '/cache' }),
    remoteFs: async () => ({
      list: async () => [
        entry('index.php', FileType.File, 120),
        entry('src', FileType.Directory),
      ],
      lstat: async () => ({ type: FileType.File, size: 120, mtime: 1700000000000 }),
      readFile: async () => 'contents',
    }),
    ...over,
  };
}

const tool = (context: ToolContext, name: string) =>
  createTools(context).find(t => t.name === name)!;

describe('servers', () => {
  it('lists only exposed connections, with what an agent needs to choose', async () => {
    const result = await tool(createContext(), 'servers').run({});

    expect(result.text).toContain('Staging');
    expect(result.text).toContain('sftp://deploy@staging.example.com:22/srv/app');
    expect(result.text).toContain('project: /work/site');
    expect(result.text).not.toContain('Production');
    expect((result.structured as any).servers).toHaveLength(1);
  });

  it('shows the active profile, because it decides what the id points at', async () => {
    const context = createContext({
      exposure: () => ({ exposedByDefault: true, profile: 'production' }),
    });

    const result = await tool(context, 'servers').run({});
    expect(result.text).toContain('[profile: production]');
  });

  it('explains an empty list rather than returning nothing', async () => {
    const context = createContext({ services: () => [] });

    const result = await tool(context, 'servers').run({});
    expect(result.text).toContain('No servers are exposed');
    expect(result.isError).toBeFalsy();
  });
});

describe('list, of a directory too large for one page', () => {
  /** A directory the server hands over a hundred names at a time, as SFTP does. */
  function bigDirectory(count: number, onRead: () => void = () => undefined) {
    const names = Array.from({ length: count }, (_, i) => `f${String(i).padStart(5, '0')}.log`);
    let closed = 0;
    const remote = {
      list: async () => {
        throw new Error('a large directory must not be read whole');
      },
      openListing: async () => {
        let at = 0;
        return {
          read: async () => {
            onRead();
            if (at >= names.length) {
              return undefined;
            }
            const piece = names.slice(at, at + 100).map(n => entry(n, FileType.File));
            at += 100;
            return piece;
          },
          close: async () => {
            closed += 1;
          },
        };
      },
      lstat: async () => ({ type: FileType.File, size: 0, mtime: 0 }),
      readFile: async () => '',
    };
    return { remote, names, closed: () => closed };
  }

  it('answers the first page without reading the whole directory', async () => {
    let reads = 0;
    const dir = bigDirectory(36000, () => (reads += 1));
    const result: any = await tool(createContext({ remoteFs: async () => dir.remote as any }), 'list').run({
      server: 'Staging',
    });

    expect(result.structured.entries).toHaveLength(1000);
    expect(result.structured.cursor).toBeTruthy();
    expect(reads).toBeLessThan(15);
    expect(result.text).toContain('with more to come');
  });

  it('reads on from where it stopped, page by page, to the end', async () => {
    const dir = bigDirectory(2550);
    const context = createContext({ remoteFs: async () => dir.remote as any });
    const seen: string[] = [];

    let result: any = await tool(context, 'list').run({ server: 'Staging' });
    seen.push(...result.structured.entries.map((e: any) => e.name));
    while (result.structured.cursor) {
      result = await tool(context, 'list').run({
        server: 'Staging',
        cursor: result.structured.cursor,
      });
      seen.push(...result.structured.entries.map((e: any) => e.name));
    }

    expect(seen.length).toBe(2550);
    expect(new Set(seen).size).toBe(2550);
    expect(result.text).toContain('the last of 2550');
    expect(dir.closed()).toBeGreaterThan(0);
  });

  // A directory that ends within the first page is listed as it always was.
  it('lists a small directory whole and sorted', async () => {
    const dir = bigDirectory(250);
    const result: any = await tool(createContext({ remoteFs: async () => dir.remote as any }), 'list').run({
      server: 'Staging',
    });

    expect(result.structured.total).toBe(250);
    expect(result.structured.cursor).toBeUndefined();
  });

  it('says plainly when a cursor is no longer open', async () => {
    const result: any = await tool(createContext(), 'list').run({
      server: 'Staging',
      cursor: 'gone',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('without one to start over');
  });

  // Short of time, a shorter page is better than none.
  it('hands back what it has when the call runs short of time', async () => {
    const dir = bigDirectory(36000);
    const slow = {
      ...dir.remote,
      openListing: async () => {
        const inner = await dir.remote.openListing();
        return {
          read: async () => {
            await new Promise(resolve => setTimeout(resolve, 30));
            return inner.read();
          },
          close: inner.close,
        };
      },
    };
    const context = createContext({
      remoteFs: async () => slow as any,
      callTimeout: () => 150,
    } as any);

    const result: any = await tool(context, 'list').run({ server: 'Staging' });

    expect(result.isError).toBeFalsy();
    expect(result.structured.entries.length).toBeGreaterThan(0);
    expect(result.structured.entries.length).toBeLessThan(1000);
    expect(result.structured.cursor).toBeTruthy();
  });
});

describe('list', () => {
  it('lists a directory, folders first', async () => {
    const result = await tool(createContext(), 'list').run({
      server: 'Staging',
      path: '/srv/app',
    });

    expect(result.text.split('\n')[1]).toContain('dir  src');
    expect(result.text).toContain('file index.php 120');
    expect((result.structured as any).entries).toHaveLength(2);
  });

  it('defaults to the remote root of the connection', async () => {
    let asked = '';
    const context = createContext({
      remoteFs: async () => ({
        list: async (dir: string) => {
          asked = dir;
          return [];
        },
        lstat: async () => ({ type: FileType.File, size: 0, mtime: 0 }),
        readFile: async () => '',
      }),
    });

    await tool(context, 'list').run({ server: 'Staging' });
    expect(asked).toBe('/srv/app');
  });

  it('says an empty directory is empty', async () => {
    const context = createContext({
      remoteFs: async () => ({
        list: async () => [],
        lstat: async () => ({ type: FileType.File, size: 0, mtime: 0 }),
        readFile: async () => '',
      }),
    });

    const result = await tool(context, 'list').run({ server: 'Staging' });
    expect(result.text).toContain('is empty');
  });

  it('treats a hidden server as one that does not exist', async () => {
    const result = await tool(createContext(), 'list').run({ server: 'Production' });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(UNKNOWN_SERVER);
  });

  it('answers an unknown id identically, so absence is indistinguishable', async () => {
    const missing = await tool(createContext(), 'list').run({ server: '404' });
    const hidden = await tool(createContext(), 'list').run({ server: 'Production' });

    expect(missing.text).toBe(hidden.text);
  });

  it('refuses a missing server argument', async () => {
    const result = await tool(createContext(), 'list').run({});
    expect(result.isError).toBe(true);
  });
});

describe('stat', () => {
  it('reports size, time and where a local copy would live', async () => {
    const result = await tool(createContext(), 'stat').run({
      server: 'Staging',
      path: '/srv/app/index.php',
    });

    expect(result.text).toContain('120 bytes');
    expect(result.text).toContain('/work/site/index.php');
    expect((result.structured as any).localPath).toBe('/work/site/index.php');
  });

  it('reports a path the server does not have', async () => {
    const context = createContext({
      remoteFs: async () => ({
        list: async () => [],
        lstat: async () => {
          throw new Error('file not exist');
        },
        readFile: async () => '',
      }),
    });

    const result = await tool(context, 'stat').run({
      server: 'Staging',
      path: '/srv/app/gone.php',
    });

    expect(result.text).toContain('not on the server');
    expect((result.structured as any).state).toBe('absent');
  });

  it('requires a path', async () => {
    const result = await tool(createContext(), 'stat').run({ server: 'Staging' });
    expect(result.isError).toBe(true);
  });
});

describe('localPathFor', () => {
  it('rebases a remote path onto the workspace', () => {
    expect(localPathFor(STAGING, '/srv/app/src/Service.php')).toBe(
      '/work/site/src/Service.php'
    );
  });

  it('maps the remote root to the workspace root', () => {
    expect(localPathFor(STAGING, '/srv/app')).toBe('/work/site');
  });
});

describe('a directory bigger than anyone reads', () => {
  const many = Array.from({ length: 1500 }, (unused, index) =>
    entry(`upload-${index}.jpg`, FileType.File, 10)
  );

  const paged = () =>
    createContext({
      remoteFs: async () =>
        ({
          list: async () => many,
          lstat: async () => ({ type: FileType.File, size: 10, mtime: 1000 }),
          readFile: async () => '',
        } as any),
    });

  it('shows the first thousand and says how to get the rest', async () => {
    const result = await tool(paged(), 'list').run({ server: 'Staging' });

    expect(result.text).toContain('(1500, showing 1-1000)');
    expect(result.text).toContain('offset: 1000');
    expect((result.structured as any).entries).toHaveLength(1000);
    expect((result.structured as any).nextOffset).toBe(1000);
    expect((result.structured as any).total).toBe(1500);
  });

  it('reads on from where it stopped', async () => {
    // "Narrow it with a subdirectory" is not advice anyone can take when the
    // directory has no subdirectories in it.
    const first: any = await tool(paged(), 'list').run({ server: 'Staging' });
    const second: any = await tool(paged(), 'list').run({
      server: 'Staging',
      offset: first.structured.nextOffset,
    });

    expect(second.structured.entries).toHaveLength(500);
    expect(second.structured.nextOffset).toBeUndefined();
    expect(second.text).not.toContain('more.');

    const seen = first.structured.entries
      .concat(second.structured.entries)
      .map((listed: any) => listed.name);
    expect(new Set(seen).size).toBe(1500);
  });

  it('is unbothered by an offset past the end', async () => {
    const result: any = await tool(paged(), 'list').run({
      server: 'Staging',
      offset: 9000,
    });

    expect(result.structured.entries).toEqual([]);
    expect(result.structured.nextOffset).toBeUndefined();
  });

  it('ignores an offset that is not a number', async () => {
    const result: any = await tool(paged(), 'list').run({
      server: 'Staging',
      offset: 'lots',
    });

    expect(result.structured.offset).toBe(0);
    expect(result.structured.entries).toHaveLength(1000);
  });

  it('says nothing about truncation when there is none', async () => {
    const result = await tool(createContext(), 'list').run({ server: 'Staging' });

    expect(result.text).not.toContain('more.');
    expect((result.structured as any).truncated).toBe(false);
  });
});
