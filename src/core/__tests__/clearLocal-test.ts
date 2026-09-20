jest.mock('fs');

import { vol } from 'memfs';
import { isWithin, NEVER_REMOVED, planClearance } from '../clearLocal';

/**
 * A folder downloaded across a year of deploys holds files the server deleted
 * months ago, and nothing downstream can tell those from current ones. What
 * gets cleared has to be exactly what was described before it went.
 */
beforeEach(() => vol.reset());

describe('planning what to clear', () => {
  it('takes everything under the folder, and says how much', async () => {
    vol.fromJSON({
      '/work/site/index.php': '<?php',
      '/work/site/app/boot.php': '<?php run();',
      '/work/site/app/old/gone.php': 'x',
    });

    const plan = await planClearance('/work/site');

    expect(plan.files).toBe(3);
    expect(plan.bytes).toBe(5 + 12 + 1);
    expect(plan.kept).toBe(0);
  });

  it('removes a folder nothing keeps back as one thing', async () => {
    vol.fromJSON({
      '/work/site/app/one.php': 'a',
      '/work/site/app/two.php': 'b',
      '/work/site/index.php': 'c',
    });

    const plan = await planClearance('/work/site');

    // The folder itself, not each file in it: one operation, not two.
    expect(plan.paths.sort()).toEqual(['/work/site/app', '/work/site/index.php']);
  });

  it('never removes a repository, at any depth', async () => {
    vol.fromJSON({
      '/work/site/.git/HEAD': 'ref: refs/heads/main',
      '/work/site/app/.git/HEAD': 'ref: refs/heads/main',
      '/work/site/app/boot.php': '<?php',
    });

    const plan = await planClearance('/work/site');

    expect(plan.paths).toEqual(['/work/site/app/boot.php']);
    expect(plan.kept).toBe(2);
    expect(plan.keptFor).toContain('never removed');
    // And the folders holding them survive, because their contents must.
    expect(plan.paths).not.toContain('/work/site/app');
  });

  it('leaves what the connection ignores', async () => {
    vol.fromJSON({
      '/work/site/index.php': '<?php',
      '/work/site/node_modules/left/index.js': 'x',
    });

    const plan = await planClearance('/work/site', {
      ignore: fsPath => fsPath.indexOf('node_modules') !== -1,
    });

    expect(plan.paths).toEqual(['/work/site/index.php']);
    expect(plan.keptFor).toContain('ignored');
  });

  it('keeps the folder that was asked about', async () => {
    vol.fromJSON({ '/work/site/index.php': '<?php' });

    const plan = await planClearance('/work/site');

    expect(plan.paths).not.toContain('/work/site');
  });

  it('says there is nothing to do rather than failing', async () => {
    vol.fromJSON({ '/work/site/.keep': '' });

    expect((await planClearance('/work/site/missing')).paths).toEqual([]);

    vol.reset();
    vol.mkdirSync('/work/site', { recursive: true } as any);
    expect((await planClearance('/work/site')).paths).toEqual([]);
  });

  it('protects the editor’s own folder and the other repositories', () => {
    expect(NEVER_REMOVED).toEqual(
      expect.arrayContaining(['.git', '.svn', '.hg', '.vscode'])
    );
  });
});

describe('the boundary it will not cross', () => {
  it('knows what is below what', () => {
    expect(isWithin('/work/site', '/work/site')).toBe(true);
    expect(isWithin('/work/site', '/work/site/app')).toBe(true);
    expect(isWithin('/work/site', '/work/other')).toBe(false);
    expect(isWithin('/work/site', '/work/site/../other')).toBe(false);
    expect(isWithin('/work/site', '/')).toBe(false);
  });
});
