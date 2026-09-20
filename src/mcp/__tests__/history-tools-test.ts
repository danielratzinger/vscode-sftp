jest.mock('fs');

import { vol } from 'memfs';
import { createTools, ToolContext } from '../tools';
import { ServiceLike } from '../exposure';
import { FileType } from '../../core/fs';
import { folderNameFor, forgetIndex } from '../localHistory';

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

const REMOTE = ['<?php', 'echo "one";', 'echo "two";', 'echo "three";'].join('\n');
const LOCAL = ['<?php', 'echo "one";', 'echo "TWO";', 'echo "three";'].join('\n');
const OLDER = ['<?php', 'echo "one";', 'echo "two";'].join('\n');

const URI = 'file:///work/site/index.php';
const FOLDER = folderNameFor(URI);
const NOW = 1_700_000_000_000;

function createContext(over: Partial<ToolContext> = {}): ToolContext {
  return {
    services: () => [STAGING],
    exposure: () => ({ exposedByDefault: true }),
    cacheOption: () => ({ cacheRoot: '/cache' }),
    historyRoot: () => '/history',
    uriFor: (localPath: string) => `file://${localPath}`,
    remoteFs: async () => ({
      list: async () => [],
      lstat: async () => ({
        type: FileType.File,
        size: Buffer.byteLength(REMOTE),
        mtime: NOW,
      }),
      readFile: async () => REMOTE,
    }),
    ...over,
  } as any;
}

const tool = (context: ToolContext, name: string) =>
  createTools(context).find(t => t.name === name)!;

beforeEach(() => {
  vol.reset();
  vol.fromJSON({
    '/work/site/index.php': LOCAL,
    [`/history/${FOLDER}/entries.json`]: JSON.stringify({
      version: 1,
      resource: URI,
      entries: [
        { id: 'aaaa.php', timestamp: NOW - 7200 * 1000 },
        { id: 'bbbb.php', timestamp: NOW - 600 * 1000, source: 'undoRedo.source' },
      ],
    }),
    [`/history/${FOLDER}/aaaa.php`]: OLDER,
    [`/history/${FOLDER}/bbbb.php`]: REMOTE,
  });
  forgetIndex();
});

describe('history', () => {
  it('lists the versions the editor still holds, newest first', async () => {
    const result: any = await tool(createContext(), 'history').run({
      server: 'Staging',
      path: '/srv/app/index.php',
    });

    expect(result.structured.versions.map((v: any) => v.id)).toEqual([
      'bbbb.php',
      'aaaa.php',
    ]);
    expect(result.text).toContain('undoRedo.source');
    expect(result.text).toContain('ago');
  });

  it('returns one version by id, and by position', async () => {
    const byId: any = await tool(createContext(), 'history').run({
      server: 'Staging',
      path: '/srv/app/index.php',
      version: 'aaaa.php',
    });
    const byIndex: any = await tool(createContext(), 'history').run({
      server: 'Staging',
      path: '/srv/app/index.php',
      version: '1',
    });

    expect(byId.text).toContain('echo "two";');
    expect(byId.text).not.toContain('echo "three";');
    expect(byIndex.structured.version).toBe('aaaa.php');
  });

  it('says plainly when there is no history for a file', async () => {
    const result: any = await tool(createContext(), 'history').run({
      server: 'Staging',
      path: '/srv/app/untouched.php',
    });

    expect(result.text).toContain('no earlier versions');
    expect(result.structured.versions).toEqual([]);
  });

  it('says so when the editor keeps no history at all', async () => {
    const off = createContext({ historyRoot: () => undefined });

    const result: any = await tool(off, 'history').run({
      server: 'Staging',
      path: '/srv/app/index.php',
    });

    expect(result.text).toContain('workbench.localHistory.enabled');
  });

  it('will not serve the history of a file it would not serve', async () => {
    // A denied file's earlier versions are just as much a credential.
    const result: any = await tool(createContext(), 'history').run({
      server: 'Staging',
      path: '/srv/app/.env',
    });

    expect(result.isError).toBe(true);
  });

  it('refuses a path outside the connection', async () => {
    const result: any = await tool(createContext(), 'history').run({
      server: 'Staging',
      path: '/etc/passwd',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('outside /srv/app');
  });
});

describe('diff', () => {
  it('compares the server with the working copy by default', async () => {
    const result: any = await tool(createContext(), 'diff').run({
      server: 'Staging',
      path: '/srv/app/index.php',
    });

    expect(result.text).toContain('--- server');
    expect(result.text).toContain('+++ working copy');
    expect(result.text).toContain('-echo "two";');
    expect(result.text).toContain('+echo "TWO";');
    expect(result.structured.added).toBe(1);
    expect(result.structured.removed).toBe(1);
  });

  it('compares an earlier version with what is on disk now', async () => {
    const result: any = await tool(createContext(), 'diff').run({
      server: 'Staging',
      path: '/srv/app/index.php',
      left: 'aaaa.php',
      right: 'local',
    });

    expect(result.structured.changed).toBe(true);
    expect(result.text).toContain('+echo "three";');
  });

  it('says when two sides are identical', async () => {
    const result: any = await tool(createContext(), 'diff').run({
      server: 'Staging',
      path: '/srv/app/index.php',
      left: 'remote',
      right: 'bbbb.php',
    });

    expect(result.structured.changed).toBe(false);
    expect(result.text).toContain('identical');
  });

  it('explains which side it could not read', async () => {
    const result: any = await tool(createContext(), 'diff').run({
      server: 'Staging',
      path: '/srv/app/index.php',
      left: 'nonsense.php',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('no version nonsense.php');
  });

  it('hides credentials on both sides, and says a change to one would not show', async () => {
    const SECRET_REMOTE = `define('DB_PASSWORD', 'old-Xk7#mQ2v');`;
    const SECRET_LOCAL = `define('DB_PASSWORD', 'new-Zt4@nR8w');`;
    vol.writeFileSync('/work/site/config.php', SECRET_LOCAL);

    const context = createContext({
      remoteFs: async () =>
        ({
          list: async () => [],
          lstat: async () => ({
            type: FileType.File,
            size: Buffer.byteLength(SECRET_REMOTE),
            mtime: NOW,
          }),
          readFile: async () => SECRET_REMOTE,
        } as any),
    });

    const result: any = await tool(context, 'diff').run({
      server: 'Staging',
      path: '/srv/app/config.php',
    });

    expect(result.text).not.toContain('old-Xk7#mQ2v');
    expect(result.text).not.toContain('new-Zt4@nR8w');
    // Both sides became the same marker, so the change vanished - which the
    // model has to be told, or it will conclude the password never changed.
    expect(result.text).toContain('does not show here');
  });
});

describe('copies kept when a download overwrote something', () => {
  function withReplaced() {
    return createContext({
      replacedVersions: async () => [
        {
          id: '1699999000000',
          timestamp: 1699999000000,
          read: async () => ['<?php', 'echo "mine";'].join('\n'),
        },
      ],
    } as any);
  }

  it('lists them beside the editor’s own versions, in one order', async () => {
    const result: any = await tool(withReplaced(), 'history').run({
      server: 'Staging',
      path: '/srv/app/index.php',
    });

    // One question - what was here before - so one list, whichever mechanism
    // happened to catch each version.
    // Interleaved by time, not grouped by where they came from.
    expect(result.structured.versions.map((v: any) => v.id)).toEqual([
      'bbbb.php',
      'replaced:1699999000000',
      'aaaa.php',
    ]);
    expect(result.text).toContain('replaced by a download');
  });

  it('reads one back', async () => {
    const result: any = await tool(withReplaced(), 'history').run({
      server: 'Staging',
      path: '/srv/app/index.php',
      version: 'replaced:1699999000000',
    });

    expect(result.text).toContain('echo "mine";');
  });

  it('diffs one against the server', async () => {
    const result: any = await tool(withReplaced(), 'diff').run({
      server: 'Staging',
      path: '/srv/app/index.php',
      left: 'replaced:1699999000000',
      right: 'remote',
    });

    expect(result.structured.changed).toBe(true);
    expect(result.text).toContain('-echo "mine";');
  });

  it('still works when nothing was ever replaced', async () => {
    const result: any = await tool(createContext(), 'history').run({
      server: 'Staging',
      path: '/srv/app/index.php',
    });

    expect(result.structured.versions).toHaveLength(2);
  });
});

describe('comparing two earlier versions', () => {
  it('labels each side by the version it is', async () => {
    // Both sides are versions of one file, often from the same afternoon, so
    // "version from 957 days ago" twice says nothing about which is which.
    const result: any = await tool(createContext(), 'diff').run({
      server: 'Staging',
      path: '/srv/app/index.php',
      left: '1',
      right: '0',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structured.left).not.toBe(result.structured.right);
    expect(result.structured.left).toContain('version ');
  });
});
