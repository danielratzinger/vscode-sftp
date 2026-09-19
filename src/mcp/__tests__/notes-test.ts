jest.mock('fs');

import { vol } from 'memfs';
import { createTools, ToolContext } from '../tools';
import { ServiceLike } from '../exposure';
import { FileType } from '../../core/fs';
import { factsFrom, load, NoteState, prune, put, viewOf } from '../notes';

const MTIME = 2000000;

const SERVER: { [path: string]: string } = {
  '/srv/app/index.php': '<?php boot();',
  '/srv/app/src/Session.php': '<?php class Session {}',
  '/srv/app/composer.json': JSON.stringify({
    name: 'xy-gmbh/website',
    description: 'Company website for XY GmbH',
    dependencies: { 'laravel/framework': '^10.0' },
  }),
};

const STAGING: ServiceLike = {
  id: 1, name: 'Staging', workspace: '/work/site', baseDir: '/work/site',
  getConfig: () => ({
    name: 'Staging', protocol: 'sftp', host: 'staging.example.com',
    port: 22, remotePath: '/srv/app',
  }),
};

function entriesOf(dir: string) {
  const children = new Map<string, any>();
  Object.keys(SERVER).forEach(p => {
    if (p.indexOf(dir + '/') !== 0) return;
    const rest = p.slice(dir.length + 1);
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    children.set(name, {
      name, fspath: `${dir}/${name}`,
      type: slash === -1 ? FileType.File : FileType.Directory,
      size: slash === -1 ? SERVER[p].length : 0,
      mtime: MTIME, atime: MTIME, mode: 0o644,
    });
  });
  return Array.from(children.values());
}

const context: ToolContext = {
  services: () => [STAGING],
  exposure: () => ({ exposedByDefault: true }),
  cacheOption: () => ({ cacheRoot: '/cache', materialize: false }),
  remoteFs: async () => ({
    list: async (dir: string) => entriesOf(dir),
    lstat: async (p: string) =>
      SERVER[p]
        ? { type: FileType.File, size: SERVER[p].length, mtime: MTIME }
        : Promise.reject(new Error('file not exist')),
    readFile: async (p: string) =>
      SERVER[p] !== undefined ? SERVER[p] : Promise.reject(new Error('nope')),
  }),
} as any;

const tool = (name: string) => createTools(context).find(t => t.name === name)!;

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ '/cache/.keep': '' });
});

describe('note store', () => {
  it('marks a note stale when the file has moved on', () => {
    const store = put({ files: {} }, '/a.php', 'does a thing', { mtime: 1000, size: 10 });

    expect(viewOf(store, '/a.php', { mtime: 1000, size: 10 }).state).toBe(NoteState.Current);
    // A confidently wrong summary is worse than none.
    const stale = viewOf(store, '/a.php', { mtime: 9000, size: 10 });
    expect(stale.state).toBe(NoteState.Stale);
    expect(stale.summary).toBe('does a thing');
  });

  it('keeps a stale note rather than dropping it', () => {
    const store = put({ files: {} }, '/a.php', 'still roughly right', { mtime: 1000, size: 10 });
    expect(store.files['/a.php']).toBeDefined();
  });

  it('prunes notes for files the server no longer has', () => {
    let store = put({ files: {} }, '/gone.php', 'x', { mtime: 1, size: 1 });
    store = put(store, '/kept.php', 'y', { mtime: 1, size: 1 });

    const result = prune(store, {
      present: p => p === '/kept.php',
      maxStaleAge: 1e9,
      maxNotes: 100,
    });

    expect(result.removed).toEqual(['/gone.php']);
    expect(result.reasons['/gone.php']).toContain('no longer has it');
    expect(Object.keys(result.store.files)).toEqual(['/kept.php']);
  });

  it('prunes a note nobody has confirmed for too long', () => {
    const store = put({ files: {} }, '/old.php', 'x', { mtime: 1, size: 1 });

    const result = prune(store, {
      present: () => true,
      maxStaleAge: 1000,
      maxNotes: 100,
      now: Date.now() + 5000,
    });

    expect(result.removed).toEqual(['/old.php']);
    expect(result.reasons['/old.php']).toContain('too long');
  });

  it('evicts the least recently updated when full', () => {
    let store: any = { files: {} };
    ['a', 'b', 'c'].forEach((name, index) => {
      store = put(store, `/${name}.php`, name, { mtime: 1, size: 1 });
      store.files[`/${name}.php`].updated = Date.now() - 1000 + index;
    });

    const result = prune(store, { present: () => true, maxStaleAge: 1e12, maxNotes: 2 });

    expect(result.removed).toEqual(['/a.php']);
  });
});

describe('factsFrom', () => {
  it('reads a project identity out of composer.json', () => {
    const facts = factsFrom({ '/srv/app/composer.json': SERVER['/srv/app/composer.json'] });

    expect(facts['composer name']).toBe('xy-gmbh/website');
    expect(facts['composer description']).toBe('Company website for XY GmbH');
    expect(facts.framework).toContain('laravel');
  });

  it('reads a WordPress theme header', () => {
    const facts = factsFrom({
      '/srv/style.css': '/*\nTheme Name: Acme Child\nAuthor: Acme GmbH\n*/',
    });

    expect(facts['wordpress theme']).toBe('Acme Child');
    expect(facts['theme author']).toBe('Acme GmbH');
  });

  it('says nothing rather than guessing', () => {
    expect(factsFrom({ '/srv/composer.json': 'not json at all' })).toEqual({});
    expect(factsFrom({})).toEqual({});
  });
});

describe('sftp_note and sftp_tree', () => {
  it('records a description and shows it in the tree', async () => {
    await tool('sftp_note').run({
      server: '1',
      path: '/srv/app/src/Session.php',
      summary: 'session handling',
    });

    const tree = await tool('sftp_tree').run({ server: '1' });

    expect(tree.text).toContain('/srv/app/src/Session.php — session handling');
    expect(tree.text).toContain('1 described');
  });

  it('nudges towards describing what is not yet described', async () => {
    const tree = await tool('sftp_tree').run({ server: '1' });
    expect(tree.text).toContain('sftp_note');
  });

  it('flags a description whose file has changed', async () => {
    const cacheRoot = '/cache';
    await tool('sftp_note').run({
      server: '1', path: '/srv/app/index.php', summary: 'entry point',
    });

    // The file moves on without the note being refreshed.
    const store = await load(cacheRoot, '1');
    store.files['/srv/app/index.php'].mtime = MTIME - 500000;
    vol.writeFileSync('/cache/1/notes.json', JSON.stringify(store));

    const tree = await tool('sftp_tree').run({ server: '1' });
    expect(tree.text).toContain('stale: the file has changed since');
  });

  it('refuses to describe a file the server does not have', async () => {
    const result = await tool('sftp_note').run({
      server: '1', path: '/srv/app/imaginary.php', summary: 'nothing',
    });

    expect(result.isError).toBe(true);
  });

  it('forgets one description, and all of them', async () => {
    await tool('sftp_note').run({ server: '1', path: '/srv/app/index.php', summary: 'a' });
    await tool('sftp_note').run({ server: '1', path: '/srv/app/src/Session.php', summary: 'b' });

    await tool('sftp_forget').run({ server: '1', path: '/srv/app/index.php' });
    expect(Object.keys((await load('/cache', '1')).files)).toEqual(['/srv/app/src/Session.php']);

    const all = await tool('sftp_forget').run({ server: '1' });
    expect(all.text).toContain('Forgot 1');
    expect(Object.keys((await load('/cache', '1')).files)).toEqual([]);
  });
});

describe('sftp_overview', () => {
  it('reports what the project is, from facts alone', async () => {
    const result = await tool('sftp_overview').run({ server: '1' });

    expect(result.text).toContain('Company website for XY GmbH');
    expect(result.text).toContain('laravel');
    expect((result.structured as any).facts['composer name']).toBe('xy-gmbh/website');
  });

  it('says so when there is nothing identifying', async () => {
    const bare = {
      ...context,
      remoteFs: async () => ({
        list: async () => [],
        lstat: async () => ({ type: FileType.File, size: 0, mtime: 0 }),
        readFile: async () => Promise.reject(new Error('nope')),
      }),
    } as any;

    const result = await createTools(bare)
      .find(t => t.name === 'sftp_overview')!
      .run({ server: '1' });

    expect(result.text).toContain('Nothing identifying');
  });
});

describe('a description is checked wherever the file is', () => {
  /** Ages the stored note so the file it describes has moved on. */
  async function ageTheNote(remotePath: string) {
    const store = await load('/cache', '1');
    store.files[remotePath].mtime = MTIME - 500000;
    vol.writeFileSync('/cache/1/notes.json', JSON.stringify(store));
  }

  it('repeats a current description when the file is stat-ed', async () => {
    await tool('sftp_note').run({
      server: '1', path: '/srv/app/index.php', summary: 'entry point',
    });

    const result = await tool('sftp_stat').run({
      server: '1', path: '/srv/app/index.php',
    });

    expect(result.text).toContain('Noted: entry point');
    expect((result.structured as any).note.state).toBe(NoteState.Current);
  });

  it('flags a stale description when the file is stat-ed', async () => {
    // Without this, a wrong description is only ever caught by a tree walk -
    // and nothing makes an agent walk the tree.
    await tool('sftp_note').run({
      server: '1', path: '/srv/app/index.php', summary: 'entry point',
    });
    await ageTheNote('/srv/app/index.php');

    const result = await tool('sftp_stat').run({
      server: '1', path: '/srv/app/index.php',
    });

    expect(result.text).toContain('entry point');
    expect(result.text).toContain('changed since');
    expect(result.text).toContain('sftp_note');
    expect((result.structured as any).note.state).toBe(NoteState.Stale);
  });

  it('flags a stale description to the one caller that can fix it', async () => {
    // Reading the file is the moment the summary can actually be rewritten.
    await tool('sftp_note').run({
      server: '1', path: '/srv/app/index.php', summary: 'entry point',
    });
    await ageTheNote('/srv/app/index.php');

    const result = await tool('sftp_fetch').run({
      server: '1', path: '/srv/app/index.php',
    });

    expect(result.text).toContain('changed since');
    expect(result.text).toContain('<?php boot();');
    expect((result.structured as any).note.state).toBe(NoteState.Stale);
  });

  it('says nothing about files nobody has described', async () => {
    const result = await tool('sftp_stat').run({
      server: '1', path: '/srv/app/index.php',
    });

    expect(result.text).not.toContain('sftp_note');
    expect((result.structured as any).note.state).toBe(NoteState.None);
  });
});

describe('the cache is swept when the tree is walked', () => {
  it('drops cached bytes for a file the server no longer has', async () => {
    vol.fromJSON({
      '/cache/1/srv/app/index.php': 'still there',
      '/cache/1/srv/app/deleted.php': 'gone from the server',
    });

    await tool('sftp_tree').run({ server: '1' });

    // Notes are pruned on a complete walk; the bytes get the same sweep.
    expect(vol.existsSync('/cache/1/srv/app/deleted.php')).toBe(false);
    expect(vol.existsSync('/cache/1/srv/app/index.php')).toBe(true);
  });

  it('leaves another connection’s cache alone', async () => {
    vol.fromJSON({ '/cache/2/srv/app/whatever.php': 'not ours to sweep' });

    await tool('sftp_tree').run({ server: '1' });

    expect(vol.existsSync('/cache/2/srv/app/whatever.php')).toBe(true);
  });

  it('does not sweep on a walk that hit its limit', async () => {
    // A truncated walk would look like most of the server had been deleted.
    vol.fromJSON({ '/cache/1/srv/app/deleted.php': 'gone' });

    const narrow = {
      ...context,
      walkOption: () => ({
        maxDepth: 0,
        maxFiles: 1,
        excludeFolders: [],
        excludeExtensions: [],
      }),
    } as any;

    await createTools(narrow)
      .find(t => t.name === 'sftp_tree')!
      .run({ server: '1' });

    expect(vol.existsSync('/cache/1/srv/app/deleted.php')).toBe(true);
  });
});

describe('reading on through a large tree', () => {
  const MANY: { [path: string]: string } = {};
  for (let i = 0; i < 1200; i += 1) {
    MANY[`/srv/app/file-${i}.php`] = '<?php';
  }

  function bigContext() {
    return {
      ...context,
      remoteFs: async () => ({
        list: async (dir: string) =>
          dir !== '/srv/app'
            ? []
            : Object.keys(MANY).map(path => ({
                name: path.split('/').pop(),
                fspath: path,
                type: FileType.File,
                size: MANY[path].length,
                mtime: MTIME,
                atime: MTIME,
                mode: 0o644,
              })),
        lstat: async (p: string) =>
          MANY[p]
            ? { type: FileType.File, size: MANY[p].length, mtime: MTIME }
            : Promise.reject(new Error('file not exist')),
        readFile: async (p: string) => MANY[p],
      }),
    } as any;
  }

  const treeOf = (ctx: any) =>
    createTools(ctx).find(t => t.name === 'sftp_tree')!;

  it('shows a page and says where the rest starts', async () => {
    const result: any = await treeOf(bigContext()).run({ server: '1' });

    expect(result.structured.total).toBe(1200);
    expect(result.structured.files).toHaveLength(1000);
    expect(result.structured.nextOffset).toBe(1000);
    expect(result.text).toContain('showing 1-1000');
    expect(result.text).toContain('offset: 1000');
  });

  it('continues without walking the server again', async () => {
    let listings = 0;
    const counting = {
      ...bigContext(),
      remoteFs: async () => {
        const fs = await bigContext().remoteFs();
        return {
          ...fs,
          list: async (dir: string) => {
            listings += 1;
            return fs.list(dir);
          },
        };
      },
    } as any;

    await treeOf(counting).run({ server: '1' });
    const walked = listings;

    const second: any = await treeOf(counting).run({ server: '1', offset: 1000 });

    // Page two costing page one all over again is no way to offer paging.
    expect(listings).toBe(walked);
    expect(second.structured.files).toHaveLength(200);
    expect(second.structured.nextOffset).toBeUndefined();
  });
});

describe('reading on through a search', () => {
  it('says where it stopped and carries on from there', async () => {
    const first: any = await tool('sftp_search').run({
      server: '1',
      query: 'boot',
      max_matches: 1,
    });

    // It stopped at the match limit, with files left unsearched.
    expect(first.structured.nextOffset).toBeDefined();
    expect(first.text).toContain('offset:');

    const second: any = await tool('sftp_search').run({
      server: '1',
      query: 'class',
      offset: first.structured.nextOffset,
    });

    expect(second.structured.offset).toBe(first.structured.nextOffset);
    expect(second.text).toContain('Session.php');
  });

  it('says nothing about carrying on when it read everything', async () => {
    const result: any = await tool('sftp_search').run({
      server: '1',
      query: 'nothing matches this',
    });

    expect(result.structured.nextOffset).toBeUndefined();
    expect(result.text).not.toContain('Call again with offset');
  });
});
