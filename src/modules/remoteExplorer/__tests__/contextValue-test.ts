jest.mock('fs');

import { vol } from 'memfs';
import {
  forgetRepositoryAnswers,
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
