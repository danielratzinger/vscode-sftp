jest.mock('fs');

import { vol } from 'memfs';
import { indexWrittenAt, vanished } from '../trackedFiles';

/**
 * "Disappeared" and "removed from the project" are not the same event, and
 * only the second is a reason to take something off a live server.
 */

beforeEach(() => vol.reset());

describe('what left the index', () => {
  it('is what was there before and is not there now', () => {
    const before = new Set(['/r/a.php', '/r/b.php', '/r/c.php']);
    const after = new Set(['/r/a.php', '/r/c.php']);

    expect(vanished(before, after)).toEqual(['/r/b.php']);
  });

  it('is nothing when the index only grew', () => {
    const before = new Set(['/r/a.php']);
    const after = new Set(['/r/a.php', '/r/b.php']);

    expect(vanished(before, after)).toEqual([]);
  });

  it('is everything when the index emptied', () => {
    expect(vanished(new Set(['/r/a.php']), new Set())).toEqual(['/r/a.php']);
  });
});

describe('noticing that git wrote the index', () => {
  it('reads the index of the repository a folder is in', async () => {
    vol.fromJSON({ '/r/.git/index': 'x', '/r/a.php': 'y' });
    vol.utimesSync('/r/.git/index', new Date(5000), new Date(5000));

    expect(await indexWrittenAt('/r')).toBe(5000);
  });

  it('reads a linked worktree’s own index, not the shared one', async () => {
    // A worktree has its own index beside its own HEAD, which is the whole
    // point of it; looking at the repository's would miss every change.
    vol.fromJSON({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.git/index': 'shared',
      '/repo/.git/worktrees/feature/commondir': '../..\n',
      '/repo/.git/worktrees/feature/index': 'mine',
      '/checkouts/feature/.git': 'gitdir: /repo/.git/worktrees/feature\n',
      '/checkouts/feature/a.php': 'x',
    });
    vol.utimesSync('/repo/.git/index', new Date(1000), new Date(1000));
    vol.utimesSync('/repo/.git/worktrees/feature/index', new Date(9000), new Date(9000));

    expect(await indexWrittenAt('/checkouts/feature')).toBe(9000);
  });

  it('says nothing about a folder that is not a repository', async () => {
    vol.fromJSON({ '/plain/index.php': 'x' });

    expect(await indexWrittenAt('/plain')).toBeUndefined();
  });
});
