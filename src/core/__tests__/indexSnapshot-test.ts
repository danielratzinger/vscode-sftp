import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { indexTree, leftBetween } from '../indexSnapshot';

/** A real repository, because what is being relied on is git's own answer. */
let root: string;

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function write(file: string, content = 'x') {
  fse.outputFileSync(path.join(root, file), content);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'index-snapshot-')));
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  ['index.php', 'lib/a.php', 'lib/b.php', 'old-name.php'].forEach(one => write(one, one));
  git('add', '-A');
  git('commit', '-qm', 'start');
});

afterEach(() => fse.removeSync(root));

describe('what left the index while nobody was watching', () => {
  it('names a file removed from git', async () => {
    const before = (await indexTree(root))!;
    git('rm', '-q', 'lib/b.php');

    expect(await leftBetween(root, before, (await indexTree(root))!)).toEqual([
      path.join(root, 'lib/b.php'),
    ]);
  });

  it('names the old name of a rename', async () => {
    const before = (await indexTree(root))!;
    git('mv', 'old-name.php', 'new-name.php');

    expect(await leftBetween(root, before, (await indexTree(root))!)).toEqual([
      path.join(root, 'old-name.php'),
    ]);
  });

  it('names a file that left by a branch switch', async () => {
    git('checkout', '-qb', 'other');
    write('only-here.php');
    git('add', '-A');
    git('commit', '-qm', 'more');
    const before = (await indexTree(root))!;
    git('checkout', '-q', '-');

    expect(await leftBetween(root, before, (await indexTree(root))!)).toEqual([
      path.join(root, 'only-here.php'),
    ]);
  });

  // Deleted on disk and nothing more: still in the index, still deployed.
  it('names nothing for a file only gone from the disk', async () => {
    const before = (await indexTree(root))!;
    fs.unlinkSync(path.join(root, 'lib/a.php'));

    expect(await leftBetween(root, before, (await indexTree(root))!)).toEqual([]);
  });

  it('names nothing when files were only added or changed', async () => {
    const before = (await indexTree(root))!;
    write('index.php', 'changed');
    write('added.php');
    git('add', '-A');

    expect(await leftBetween(root, before, (await indexTree(root))!)).toEqual([]);
  });

  // A tree git no longer has must not read as "nothing left" - or as anything.
  it('cannot answer about a tree git does not have', async () => {
    const missing = 'f'.repeat(40);

    expect(await leftBetween(root, missing, (await indexTree(root))!)).toBeUndefined();
  });
});

describe('the index as a tree', () => {
  it('is nothing outside a repository', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      expect(await indexTree(elsewhere)).toBeUndefined();
    } finally {
      fse.removeSync(elsewhere);
    }
  });

  it('is the same id for the same files', async () => {
    expect(await indexTree(root)).toBe(await indexTree(root));
  });
});
