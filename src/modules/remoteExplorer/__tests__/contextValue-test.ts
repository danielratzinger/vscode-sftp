jest.mock('fs');

import { vol } from 'memfs';
import {
  forgetRepositoryAnswers,
  hasLocalCopy,
  localCopyIsInARepository,
} from '../treeDataProvider';

/**
 * The tree item's context value is what a menu matches on, and it is the only
 * per-item thing a `when` clause can see. `Clear Local Folder` has to be off
 * the menu for anything in a working copy - so the tree has to say which
 * those are.
 */
const WORKSPACE = '/work/site';

beforeEach(() => {
  vol.reset();
  forgetRepositoryAnswers();
});

describe('a folder whose local copy is in a repository', () => {
  it('is one when git is right there', () => {
    vol.fromJSON({ '/work/site/.git/HEAD': 'ref: refs/heads/main' });

    expect(localCopyIsInARepository('/work/site', WORKSPACE)).toBe(true);
  });

  it('is one when .git is a file, as in a worktree or a submodule', () => {
    vol.fromJSON({ '/work/site/.git': 'gitdir: ../.git/worktrees/site' });

    expect(localCopyIsInARepository('/work/site', WORKSPACE)).toBe(true);
  });

  it('is one for the other two as well', () => {
    vol.fromJSON({ '/work/site/.svn/entries': '', '/work/other/.hg/store': '' });

    expect(localCopyIsInARepository('/work/site', WORKSPACE)).toBe(true);
    expect(localCopyIsInARepository('/work/other', '/work/other')).toBe(true);
  });

  it('is one for a folder deep inside it', () => {
    // What this last change was about: the repository is at the top and the
    // folder being cleared is three levels down, its files tracked by it.
    vol.fromJSON({
      '/work/site/.git/HEAD': 'ref',
      '/work/site/app/views/partials/head.php': '<?php',
    });

    expect(localCopyIsInARepository('/work/site/app/views/partials', WORKSPACE)).toBe(true);
  });

  it('is not one for an ordinary folder under an ordinary workspace', () => {
    vol.fromJSON({ '/work/site/app/boot.php': '<?php' });

    expect(localCopyIsInARepository('/work/site/app', WORKSPACE)).toBe(false);
    expect(localCopyIsInARepository('/work/site', WORKSPACE)).toBe(false);
  });

  it('stops at the workspace, whatever is above it', () => {
    // An unbounded walk makes the answer depend on how somebody keeps their
    // home directory.
    vol.fromJSON({ '/work/.git/HEAD': 'ref', '/work/site/app/boot.php': '<?php' });

    expect(localCopyIsInARepository('/work/site/app', WORKSPACE)).toBe(false);
  });

  it('answers for a folder that was never downloaded', () => {
    vol.fromJSON({ '/work/site/.git/HEAD': 'ref' });

    expect(localCopyIsInARepository('/work/site/never/downloaded', WORKSPACE)).toBe(true);
  });

  it('forgets what it knew when the tree is refreshed', () => {
    vol.fromJSON({ '/work/site/app/boot.php': '<?php' });
    expect(localCopyIsInARepository('/work/site/app', WORKSPACE)).toBe(false);

    vol.fromJSON({ '/work/site/.git/HEAD': 'ref', '/work/site/app/boot.php': '<?php' });
    expect(localCopyIsInARepository('/work/site/app', WORKSPACE)).toBe(false);

    forgetRepositoryAnswers();
    expect(localCopyIsInARepository('/work/site/app', WORKSPACE)).toBe(true);
  });
});

describe('whether there is anything on this machine to show', () => {
  it('knows a folder that has been downloaded from one that has not', () => {
    vol.fromJSON({ '/work/site/app/boot.php': '<?php' });

    expect(hasLocalCopy('/work/site/app')).toBe(true);
    expect(hasLocalCopy('/work/site/app/boot.php')).toBe(true);
    expect(hasLocalCopy('/work/site/never')).toBe(false);
  });

  it('says no rather than throwing on a path it cannot look at', () => {
    expect(hasLocalCopy('')).toBe(false);
  });
});

/**
 * The other half of the contract, and the half nothing was checking: the
 * `when` clauses in `package.json` have to match the context values the tree
 * actually produces. They are regular expressions in a JSON string, matched by
 * the editor and by nothing here, so a marker added to a context value can
 * quietly stop `Clear Local Folder` ever appearing again and every test still
 * passes.
 */
// tslint:disable-next-line:no-var-requires
const manifest = require('../../../../package.json');

/**
 * Whether a command's menu entry would show for a context value.
 *
 * The whole `when` clause, not the first pattern in it: `Autosync Worktree`
 * asks two things about the item - that it is a root and that it is *not*
 * syncing - and reading only the first says it appears on connections where it
 * does not. Everything that is not about `viewItem` is taken as true, since
 * those are about the window rather than the item.
 */
function menuShows(command: string, viewItem: string): boolean {
  const entry = manifest.contributes.menus['view/item/context'].find(
    (one: any) => one.command === command && /viewItem/.test(one.when || '')
  );

  expect(entry).toBeDefined();

  return entry.when.split('&&').every((term: string) => {
    const clause = term.trim();

    const negated = /^!\(viewItem =~ \/(.+)\/\)$/.exec(clause);
    if (negated) {
      return !new RegExp(negated[1]).test(viewItem);
    }

    const plain = /^viewItem =~ \/(.+)\/$/.exec(clause);
    if (plain) {
      return new RegExp(plain[1]).test(viewItem);
    }

    return true;
  });
}

/** Every shape `_describe` can produce for a connection's root. */
const ROOTS = [
  'root',
  'root-local',
  'root-repo-local',
  'root-autosync',
  'root-autosync-local',
  'root-autosync-repo-local',
  'root-autosyncaway-local',
  'root-autosyncaway-repo-local',
];

describe('the menu patterns against the values the tree produces', () => {
  it('offers Clear Local Folder on a plain local root, syncing or not', () => {
    expect(menuShows('sftp.clear.localFolder', 'root-local')).toBe(true);
    expect(menuShows('sftp.clear.localFolder', 'folder-local')).toBe(true);
    expect(menuShows('sftp.clear.localFolder', 'root-autosync-local')).toBe(true);
    expect(menuShows('sftp.clear.localFolder', 'root-autosyncaway-local')).toBe(true);
  });

  it('keeps Clear Local Folder off a working copy, syncing or not', () => {
    expect(menuShows('sftp.clear.localFolder', 'root-repo-local')).toBe(false);
    expect(menuShows('sftp.clear.localFolder', 'root-autosync-repo-local')).toBe(false);
    expect(menuShows('sftp.clear.localFolder', 'root')).toBe(false);
  });

  it('offers Reveal in Terminal wherever there is a local copy', () => {
    expect(menuShows('sftp.revealInTerminal', 'root-local')).toBe(true);
    expect(menuShows('sftp.revealInTerminal', 'root-repo-local')).toBe(true);
    expect(menuShows('sftp.revealInTerminal', 'root-autosync-repo-local')).toBe(true);
    expect(menuShows('sftp.revealInTerminal', 'root')).toBe(false);
    expect(menuShows('sftp.revealInTerminal', 'file-local')).toBe(false);
  });

  it('swaps Autosync for Switch Autosync on the connection that is syncing', () => {
    // The pair have to be exclusive, or both appear on the same menu.
    ROOTS.forEach(value => {
      const syncing = value.indexOf('-autosync') !== -1;

      expect(menuShows('sftp.switchAutosyncWorktree', value)).toBe(syncing);
      expect(menuShows('sftp.autosyncWorktree', value)).toBe(!syncing);
    });
  });

  it('offers Stop on exactly the connections that are syncing', () => {
    ROOTS.forEach(value =>
      expect(menuShows('sftp.stopAutosyncWorktree', value)).toBe(
        value.indexOf('-autosync') !== -1
      )
    );
  });

  it('offers the reveal commands only where the folder is somewhere else', () => {
    expect(menuShows('sftp.autosyncReveal.terminal', 'root-autosyncaway-local')).toBe(true);
    // Syncing this window's own folder: revealing it would open the folder
    // already open.
    expect(menuShows('sftp.autosyncReveal.terminal', 'root-autosync-local')).toBe(false);
    expect(menuShows('sftp.autosyncReveal.terminal', 'root-local')).toBe(false);
  });
});

/**
 * The file explorer is not ours: there is no per-item value to match on, only
 * window-wide context keys. So anything decided per connection must not be
 * gated on one - `sftp.autosyncWorktreeing` means "something in this window is
 * syncing", and using it to hide `Autosync Worktree` left every other project
 * in the window unable to start.
 */
function inExplorer(command: string): any {
  return manifest.contributes.menus['explorer/context'].find(
    (one: any) => one.command === command
  );
}

function explorerShows(command: string, keys: { [key: string]: boolean }): boolean {
  const entry = inExplorer(command);
  expect(entry).toBeDefined();

  return (entry.when || '').split('&&').every((term: string) => {
    const clause = term.trim();

    if (clause.charAt(0) === '!') {
      return !keys[clause.slice(1)];
    }

    return Boolean(keys[clause]);
  });
}

describe('the file explorer menu, which has no per-item value of ours', () => {

  it('offers Autosync whether or not something else is already syncing', () => {
    // The window-wide flag must not decide this: one project syncing took the
    // option away from every other project in the window.
    expect(inExplorer('sftp.autosyncWorktree').when).not.toContain(
      'sftp.autosyncWorktreeing'
    );
  });

  it('asks about the folder itself, not about the window', () => {
    // The fix for both halves of this: `resourcePath in <key>` asks about the
    // item a menu is on, which `sftp.autosyncWorktreeing` never could. On that
    // key `Stop` appeared on every project or, once it was removed, on none.
    const stop = inExplorer('sftp.stopAutosyncWorktree').when;
    const start = inExplorer('sftp.autosyncWorktree').when;

    expect(stop).toContain('resourcePath in sftp.autosyncPaths');
    expect(start).toContain('!(resourcePath in sftp.autosyncPaths)');
    expect(stop).not.toContain('sftp.autosyncWorktreeing');
    expect(start).not.toContain('sftp.autosyncWorktreeing');
  });

  it('never offers Start and Stop on the same folder', () => {
    const clauses = ['sftp.autosyncWorktree', 'sftp.stopAutosyncWorktree'].map(
      one => inExplorer(one).when
    );

    // One asks for the folder to be in the list, the other for it not to be.
    expect(clauses[0]).toContain('!(resourcePath in');
    expect(clauses[1]).toContain('resourcePath in');
    expect(clauses[1]).not.toContain('!(resourcePath in');
  });

  it('keeps all of them in the Remote Explorer, where they can be precise', () => {
    const there = manifest.contributes.menus['view/item/context'].map(
      (one: any) => one.command
    );

    expect(there).toContain('sftp.stopAutosyncWorktree');
    expect(there).toContain('sftp.switchAutosyncWorktree');
    expect(there).toContain('sftp.autosyncReveal.terminal');
  });

  it('does not offer it on a file', () => {
    expect(explorerShows('sftp.autosyncWorktree', { 'sftp.enabled': true })).toBe(
      false
    );
  });
});
