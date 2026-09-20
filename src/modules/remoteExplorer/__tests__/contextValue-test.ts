jest.mock('fs');

import { vol } from 'memfs';
import { localCopyIsARepository } from '../treeDataProvider';

/**
 * The tree item's context value is what a menu matches on, and it is the only
 * per-item thing a `when` clause can see. `Clear Local Folder` has to be off
 * the menu for a folder whose local copy is a repository - so the tree has to
 * say which those are.
 */
beforeEach(() => vol.reset());

describe('a folder whose local copy is a repository', () => {
  it('is one when git is there', () => {
    vol.fromJSON({ '/work/site/.git/HEAD': 'ref: refs/heads/main' });

    expect(localCopyIsARepository('/work/site')).toBe(true);
  });

  it('is one when .git is a file, as in a worktree or a submodule', () => {
    vol.fromJSON({ '/work/site/.git': 'gitdir: ../.git/worktrees/site' });

    expect(localCopyIsARepository('/work/site')).toBe(true);
  });

  it('is one for the other two as well', () => {
    vol.fromJSON({ '/work/svn/.svn/entries': '', '/work/hg/.hg/store': '' });

    expect(localCopyIsARepository('/work/svn')).toBe(true);
    expect(localCopyIsARepository('/work/hg')).toBe(true);
  });

  it('is not one for a folder inside a repository', () => {
    // Its files are tracked, so deleting them is recoverable; the repository
    // itself is the thing that is not.
    vol.fromJSON({ '/work/site/.git/HEAD': 'ref', '/work/site/app/boot.php': '<?php' });

    expect(localCopyIsARepository('/work/site/app')).toBe(false);
  });

  it('is not one for an ordinary folder, or one that is not there at all', () => {
    vol.fromJSON({ '/work/site/index.php': '<?php' });

    expect(localCopyIsARepository('/work/site')).toBe(false);
    expect(localCopyIsARepository('/work/never-downloaded')).toBe(false);
  });
});
