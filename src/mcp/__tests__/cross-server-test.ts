jest.mock('fs');

import { vol } from 'memfs';
import { createTools, ToolContext } from '../tools';
import { ServiceLike } from '../exposure';
import { FileType } from '../../core/fs';

const STAGING_TEXT = ['<?php', `define('MODE', 'staging');`, 'run();'].join('\n');
const LIVE_TEXT = ['<?php', `define('MODE', 'live');`, 'run();', 'extraLine();'].join(
  '\n'
);

const FILES: { [path: string]: string } = {
  '/srv/app/config.php': STAGING_TEXT,
  '/www/config.php': LIVE_TEXT,
  '/www/.env': 'SECRET=nope',
};

function service(id: number, name: string, remotePath: string, baseDir: string, mcp?: any): ServiceLike {
  return {
    id,
    name,
    workspace: baseDir,
    baseDir,
    getConfig: () => ({
      name,
      protocol: 'sftp',
      host: `${name.toLowerCase()}.example.com`,
      port: 22,
      remotePath,
      ...(mcp ? { mcp } : {}),
    }),
  };
}

const STAGING = service(1, 'Staging', '/srv/app', '/work/site');
const LIVE = service(2, 'Production', '/www', '/work/prod');
const HIDDEN = service(3, 'Secret', '/secret', '/work/secret', { exposed: false });

function createContext(): ToolContext {
  return {
    services: () => [STAGING, LIVE, HIDDEN],
    exposure: () => ({ exposedByDefault: true }),
    cacheOption: () => ({ cacheRoot: '/cache', materialize: false }),
    remoteFs: async () => ({
      list: async () => [],
      lstat: async (p: string) =>
        FILES[p]
          ? { type: FileType.File, size: FILES[p].length, mtime: 1000 }
          : Promise.reject(new Error('file not exist')),
      readFile: async (p: string) =>
        FILES[p] !== undefined ? FILES[p] : Promise.reject(new Error('nope')),
    }),
  } as any;
}

const diffTool = () =>
  createTools(createContext()).find(t => t.name === 'sftp_diff')!;

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ '/cache/.keep': '' });
});

describe('comparing one connection with another', () => {
  it('finds the same file below a different root', async () => {
    // Two servers hosting one project mount it in different places, so "the
    // same file" is the same path below the root, not the same absolute path.
    const result: any = await diffTool().run({
      server: '1',
      path: '/srv/app/config.php',
      left: 'remote',
      right: 'server:2',
    });

    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('+++ Production (/www/config.php)');
    expect(result.text).toContain(`-define('MODE', 'staging');`);
    expect(result.text).toContain(`+define('MODE', 'live');`);
    expect(result.text).toContain('+extraLine();');
    expect(result.structured.added).toBe(2);
  });

  it('works in either direction', async () => {
    const result: any = await diffTool().run({
      server: '1',
      path: '/srv/app/config.php',
      left: 'server:2',
      right: 'remote',
    });

    expect(result.text).toContain('--- Production (/www/config.php)');
    expect(result.text).toContain('+++ server');
    expect(result.structured.removed).toBe(2);
  });

  it('says so when the other server does not have it', async () => {
    const result: any = await diffTool().run({
      server: '1',
      path: '/srv/app/missing.php',
      left: 'remote',
      right: 'server:2',
    });

    expect(result.isError).toBe(true);
  });

  it('refuses a connection that is not exposed, as if it were not there', async () => {
    const result: any = await diffTool().run({
      server: '1',
      path: '/srv/app/config.php',
      left: 'remote',
      right: 'server:3',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe('Unknown server.');
  });

  it('refuses a connection that does not exist, in the same words', async () => {
    const result: any = await diffTool().run({
      server: '1',
      path: '/srv/app/config.php',
      right: 'server:99',
    });

    expect(result.text).toBe('Unknown server.');
  });

  it('will not serve a denied file through the other side', async () => {
    // The boundary is checked again on the far side; a path inside one
    // connection has no standing in another.
    const result: any = await diffTool().run({
      server: '1',
      path: '/srv/app/.env',
      left: 'remote',
      right: 'server:2',
    });

    expect(result.isError).toBe(true);
  });

  it('refuses a path that is the root itself', async () => {
    const result: any = await diffTool().run({
      server: '1',
      path: '/srv/app',
      right: 'server:2',
    });

    expect(result.isError).toBe(true);
  });
});
