jest.mock('fs');

import { vol } from 'memfs';
import {
  checkoutsOf,
  clonesOf,
  lastEditIn,
  normaliseRemote,
  originOf,
  sameRemote,
} from '../clones';

/**
 * Agent tooling does not always add a worktree; some of it clones. A clone is
 * unrelated to yours as far as git is concerned, so what relates them is the
 * remote they came from - written a dozen different ways.
 */
beforeEach(() => vol.reset());

const config = (url: string) =>
  `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*\n`;

describe('recognising the same repository', () => {
  it('sees through how the URL is written', () => {
    const spellings = [
      'https://github.com/danielratzinger/enterprisemap.com.git',
      'https://github.com/danielratzinger/enterprisemap.com',
      'git@github.com:danielratzinger/enterprisemap.com.git',
      'ssh://git@github.com/danielratzinger/enterprisemap.com/',
      'HTTPS://GitHub.com/DanielRatzinger/EnterpriseMap.com.git',
    ];

    spellings.forEach(one =>
      expect(normaliseRemote(one)).toBe('github.com/danielratzinger/enterprisemap.com')
    );
    expect(sameRemote(spellings[0], spellings[2])).toBe(true);
  });

  it('does not confuse two repositories', () => {
    expect(
      sameRemote(
        'https://github.com/danielratzinger/enterprisemap.com.git',
        'https://github.com/danielratzinger/enterprisemap.at.git'
      )
    ).toBe(false);
    expect(sameRemote(undefined, 'https://github.com/x/y')).toBe(false);
  });

  it('reads the origin out of the config git keeps it in', async () => {
    vol.fromJSON({ '/work/site/.git/config': config('git@github.com:x/y.git') });

    expect(await originOf('/work/site/.git')).toBe('git@github.com:x/y.git');
    expect(await originOf('/nowhere/.git')).toBeUndefined();
  });

  it('ignores the url of a remote that is not origin', async () => {
    vol.fromJSON({
      '/work/site/.git/config':
        '[remote "upstream"]\n\turl = git@github.com:someone/else.git\n' +
        '[remote "origin"]\n\turl = git@github.com:x/y.git\n',
    });

    expect(await originOf('/work/site/.git')).toBe('git@github.com:x/y.git');
  });
});

describe('finding the other checkouts', () => {
  const ORIGIN = 'https://github.com/danielratzinger/enterprisemap.com.git';

  function machine() {
    vol.fromJSON({
      // The one in the window.
      '/work/enterprisemap.com/.git/config': config(ORIGIN),
      '/work/enterprisemap.com/index.php': '<?php',
      // An agent's clone, two levels down somewhere else entirely.
      '/agents/first-prototype-6/enterprisemap-com/.git/config': config(
        'https://github.com/danielratzinger/enterprisemap.com'
      ),
      '/agents/first-prototype-6/enterprisemap-com/index.php': '<?php',
      // A different project, same machine.
      '/agents/other-thing/somewhere-else/.git/config': config(
        'git@github.com:danielratzinger/cashtrack.com.git'
      ),
      // Something that is not a checkout at all.
      '/agents/notes/todo.md': '# later',
    });
  }

  it('finds a clone by its origin, wherever it sits', async () => {
    machine();

    expect(await clonesOf(ORIGIN, ['/agents'])).toEqual([
      '/agents/first-prototype-6/enterprisemap-com',
    ]);
  });

  it('leaves out the checkout you are already looking at', async () => {
    machine();

    expect(await clonesOf(ORIGIN, ['/work'], ['/work/enterprisemap.com'])).toEqual([]);
    expect(await clonesOf(ORIGIN, ['/work'])).toEqual(['/work/enterprisemap.com']);
  });

  it('does not search inside a checkout it has found', async () => {
    // Its files are not other repositories, and its own worktrees come from
    // its metadata rather than from walking it.
    machine();
    vol.fromJSON({
      '/agents/first-prototype-6/enterprisemap-com/.claude/worktrees/x/.git': 'gitdir: /x',
    });

    const found = await clonesOf(ORIGIN, ['/agents']);

    expect(found).toEqual(['/agents/first-prototype-6/enterprisemap-com']);
  });

  it('says nothing about a search root that is not there', async () => {
    machine();

    expect(await clonesOf(ORIGIN, ['/nowhere'])).toEqual([]);
  });
});

describe('when a checkout was last written in', () => {
  it('is the newest file in it', async () => {
    vol.fromJSON({
      '/work/site/old.php': 'a',
      '/work/site/src/new.php': 'b',
    });
    vol.utimesSync('/work/site/old.php', new Date(1000), new Date(1000));
    vol.utimesSync('/work/site/src/new.php', new Date(9000), new Date(9000));

    expect(await lastEditIn('/work/site')).toBe(9000);
  });

  it('does not count git’s own bookkeeping', async () => {
    vol.fromJSON({ '/work/site/a.php': 'x', '/work/site/.git/index': 'y' });
    vol.utimesSync('/work/site/a.php', new Date(1000), new Date(1000));
    vol.utimesSync('/work/site/.git/index', new Date(9000), new Date(9000));

    expect(await lastEditIn('/work/site')).toBe(1000);
  });

  it('stops after its budget rather than walking a whole disk', async () => {
    const many: { [file: string]: string } = {};
    for (let i = 0; i < 50; i += 1) {
      many[`/work/site/file${i}.php`] = 'x';
    }
    vol.fromJSON(many);

    // With a budget of five it still answers, from the five it looked at.
    expect(await lastEditIn('/work/site', 5)).toBeGreaterThan(0);
  });

  it('says nothing about a folder that is not there', async () => {
    expect(await lastEditIn('/nowhere')).toBeUndefined();
  });
});

describe('every checkout of one project', () => {
  const ORIGIN = 'https://github.com/danielratzinger/enterprisemap.com.git';

  /**
   * What is actually on this machine: the repository in the window with no
   * worktrees of its own, and an agent's clone elsewhere that has two.
   */
  function machine() {
    vol.fromJSON({
      '/work/enterprisemap.com/.git/config': config(ORIGIN),
      '/work/enterprisemap.com/.git/HEAD': 'ref: refs/heads/main\n',

      '/agents/first-prototype-6/enterprisemap-com/.git/config': config(
        'https://github.com/danielratzinger/enterprisemap.com'
      ),
      '/agents/first-prototype-6/enterprisemap-com/.git/HEAD':
        'ref: refs/heads/intent/fix/crossref\n',
      '/agents/first-prototype-6/enterprisemap-com/.git/worktrees/auth/gitdir':
        '/agents/first-prototype-6/enterprisemap-com/.claude/worktrees/auth/.git\n',
      '/agents/first-prototype-6/enterprisemap-com/.git/worktrees/auth/HEAD':
        'ref: refs/heads/intent/feat/auth-pages\n',
      '/agents/first-prototype-6/enterprisemap-com/.claude/worktrees/auth/index.php':
        '<?php',
    });
  }

  it('finds the clone\u2019s checkouts as well as its own', async () => {
    machine();

    const found = await checkoutsOf('/work/enterprisemap.com', ['/agents']);

    expect(found.map(one => one.branch)).toEqual([
      'main',
      'intent/fix/crossref',
      'intent/feat/auth-pages',
    ]);
    expect(found.filter(one => one.isMain).map(one => one.root)).toEqual([
      '/work/enterprisemap.com',
    ]);
  });

  it('does not call another clone\u2019s own folder this window\u2019s', async () => {
    machine();

    const found = await checkoutsOf('/work/enterprisemap.com', ['/agents']);
    const clone = found.find(one => one.branch === 'intent/fix/crossref');

    expect(clone!.isMain).toBe(false);
  });

  it('is only the repository\u2019s own when there is no origin to match on', async () => {
    machine();
    vol.unlinkSync('/work/enterprisemap.com/.git/config');

    expect(await checkoutsOf('/work/enterprisemap.com', ['/agents'])).toHaveLength(1);
  });

  it('is empty outside a repository, which is the caller\u2019s to answer', async () => {
    vol.fromJSON({ '/work/plain-site/index.php': '<?php' });

    expect(await checkoutsOf('/work/plain-site', ['/agents'])).toEqual([]);
  });

  it('does not list the same checkout twice', async () => {
    machine();

    const found = await checkoutsOf('/work/enterprisemap.com', [
      '/agents',
      '/agents/first-prototype-6',
    ]);

    const roots = found.map(one => one.root);
    expect(new Set(roots).size).toBe(roots.length);
  });
});
