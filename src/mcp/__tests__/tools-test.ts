import { createTools, localPathFor, ToolContext } from '../tools';
import { ServiceLike } from '../exposure';
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

describe('sftp_servers', () => {
  it('lists only exposed connections, with what an agent needs to choose', async () => {
    const result = await tool(createContext(), 'sftp_servers').run({});

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

    const result = await tool(context, 'sftp_servers').run({});
    expect(result.text).toContain('[profile: production]');
  });

  it('explains an empty list rather than returning nothing', async () => {
    const context = createContext({ services: () => [] });

    const result = await tool(context, 'sftp_servers').run({});
    expect(result.text).toContain('No servers are exposed');
    expect(result.isError).toBeFalsy();
  });
});

describe('sftp_list', () => {
  it('lists a directory, folders first', async () => {
    const result = await tool(createContext(), 'sftp_list').run({
      server: '1',
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

    await tool(context, 'sftp_list').run({ server: '1' });
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

    const result = await tool(context, 'sftp_list').run({ server: '1' });
    expect(result.text).toContain('is empty');
  });

  it('treats a hidden server as one that does not exist', async () => {
    const result = await tool(createContext(), 'sftp_list').run({ server: '2' });

    expect(result.isError).toBe(true);
    expect(result.text).toBe('Unknown server.');
  });

  it('answers an unknown id identically, so absence is indistinguishable', async () => {
    const missing = await tool(createContext(), 'sftp_list').run({ server: '404' });
    const hidden = await tool(createContext(), 'sftp_list').run({ server: '2' });

    expect(missing.text).toBe(hidden.text);
  });

  it('refuses a missing server argument', async () => {
    const result = await tool(createContext(), 'sftp_list').run({});
    expect(result.isError).toBe(true);
  });
});

describe('sftp_stat', () => {
  it('reports size, time and where a local copy would live', async () => {
    const result = await tool(createContext(), 'sftp_stat').run({
      server: '1',
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

    const result = await tool(context, 'sftp_stat').run({
      server: '1',
      path: '/srv/app/gone.php',
    });

    expect(result.text).toContain('not on the server');
    expect((result.structured as any).state).toBe('absent');
  });

  it('requires a path', async () => {
    const result = await tool(createContext(), 'sftp_stat').run({ server: '1' });
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
    const result = await tool(paged(), 'sftp_list').run({ server: '1' });

    expect(result.text).toContain('(1500, showing 1-1000)');
    expect(result.text).toContain('offset: 1000');
    expect((result.structured as any).entries).toHaveLength(1000);
    expect((result.structured as any).nextOffset).toBe(1000);
    expect((result.structured as any).total).toBe(1500);
  });

  it('reads on from where it stopped', async () => {
    // "Narrow it with a subdirectory" is not advice anyone can take when the
    // directory has no subdirectories in it.
    const first: any = await tool(paged(), 'sftp_list').run({ server: '1' });
    const second: any = await tool(paged(), 'sftp_list').run({
      server: '1',
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
    const result: any = await tool(paged(), 'sftp_list').run({
      server: '1',
      offset: 9000,
    });

    expect(result.structured.entries).toEqual([]);
    expect(result.structured.nextOffset).toBeUndefined();
  });

  it('ignores an offset that is not a number', async () => {
    const result: any = await tool(paged(), 'sftp_list').run({
      server: '1',
      offset: 'lots',
    });

    expect(result.structured.offset).toBe(0);
    expect(result.structured.entries).toHaveLength(1000);
  });

  it('says nothing about truncation when there is none', async () => {
    const result = await tool(createContext(), 'sftp_list').run({ server: '1' });

    expect(result.text).not.toContain('more.');
    expect((result.structured as any).truncated).toBe(false);
  });
});
