jest.mock('fs');

import { vol } from 'memfs';
import { parseDeleted, stillGoneIn } from '../removedFromHistory';

/**
 * The safety property is the whole point: this only ever names paths the
 * repository once tracked, so no answer it gives can remove a runtime
 * directory, an upload folder or a cache the site legitimately keeps.
 */

beforeEach(() => vol.reset());

describe('reading what git deleted', () => {
  it('takes the paths and drops the blank lines between commits', () => {
    const output = '\ncompany.php\nold/page.php\n\n\n.env.sample\n';

    expect(parseDeleted(output)).toEqual([
      '.env.sample',
      'company.php',
      'old/page.php',
    ]);
  });

  it('names a path once however many times it was deleted', () => {
    expect(parseDeleted('a.php\n\na.php\n\nb.php\n')).toEqual(['a.php', 'b.php']);
  });

  it('says nothing about an empty history', () => {
    expect(parseDeleted('\n\n')).toEqual([]);
  });
});

describe('deciding which are really gone', () => {
  it('keeps the ones that are not in the checkout', async () => {
    vol.fromJSON({ '/repo/index.php': '<?php' });

    expect(await stillGoneIn('/repo', ['company.php', 'old/page.php'])).toEqual([
      'company.php',
      'old/page.php',
    ]);
  });

  it('drops one that was deleted and written again', async () => {
    // The history says both things; only the disk settles it.
    vol.fromJSON({ '/repo/company.php': '<?php' });

    expect(await stillGoneIn('/repo', ['company.php', 'gone.php'])).toEqual([
      'gone.php',
    ]);
  });

  it('drops a directory that came back, not only a file', async () => {
    vol.fromJSON({ '/repo/old/page.php': 'x' });

    expect(await stillGoneIn('/repo', ['old/page.php'])).toEqual([]);
  });
});
