import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Candidate, findIgnored, ignoreRulesFor, within } from '../projectIgnore';

/**
 * Against real git in a real folder: the rules are git's, and the point of
 * asking git is that nobody here reimplements them. A fake would only test
 * the fake.
 */

function folderWith(files: { [relative: string]: string }): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-ignore-')));
  Object.keys(files).forEach(relative => {
    const full = path.join(root, relative);
    fse.ensureDirSync(path.dirname(full));
    fs.writeFileSync(full, files[relative]);
  });
  return root;
}

function repoWith(files: { [relative: string]: string }, tracked: string[] = []): string {
  const root = folderWith(files);
  execFileSync('git', ['init', '-q'], { cwd: root });
  if (tracked.length) {
    execFileSync('git', ['add', '-f', ...tracked], { cwd: root });
  }
  return root;
}

async function ignoredOf(root: string, relatives: string[]): Promise<string[]> {
  const rules = await ignoreRulesFor(root);
  const candidates = relatives.map(one => ({
    path: path.join(root, one.replace(/\/$/, '')),
    dir: /\/$/.test(one),
  }));
  const ignored = await rules!.ignoredAmong(candidates);
  return relatives.filter((one, at) => ignored.has(candidates[at].path));
}

describe('a project with a repository', () => {
  const root = repoWith(
    {
      '.gitignore': 'vendor/\n*.log\n!keep.log\n.env\n',
      'src/.gitignore': 'cache/\n',
      'src/a.php': '',
      'tracked.log': '',
    },
    ['tracked.log']
  );

  it('leaves out what .gitignore names, and keeps what it brings back', async () => {
    expect(await ignoredOf(root, ['a.log', 'keep.log', '.env', 'index.php'])).toEqual([
      'a.log',
      '.env',
    ]);
  });

  // What is on the server is often not on this machine at all.
  it('judges a folder that is not here as a folder', async () => {
    expect(await ignoredOf(root, ['vendor/', 'vendor/psr/log.php', 'src/cache/'])).toEqual([
      'vendor/',
      'vendor/psr/log.php',
      'src/cache/',
    ]);
  });

  it('never calls a tracked file ignored', async () => {
    expect(await ignoredOf(root, ['tracked.log'])).toEqual([]);
  });

  it('always leaves out the repository itself', async () => {
    expect(await ignoredOf(root, ['.git/'])).toEqual(['.git/']);
  });

  it('names where the rules come from', async () => {
    expect((await ignoreRulesFor(root))!.sources).toEqual(['.gitignore']);
  });
});

describe('.git-ftp-ignore', () => {
  it('is read beside .gitignore', async () => {
    const root = repoWith({ '.gitignore': '*.log\n', '.git-ftp-ignore': 'tests/\nREADME.md\n' });

    expect(await ignoredOf(root, ['tests/', 'README.md', 'a.log', 'index.php'])).toEqual([
      'tests/',
      'README.md',
      'a.log',
    ]);
    expect((await ignoreRulesFor(root))!.sources).toEqual(['.gitignore', '.git-ftp-ignore']);
  });

  it('is enough on its own, without a repository', async () => {
    const root = folderWith({ '.git-ftp-ignore': 'docs/\n' });

    expect(await ignoredOf(root, ['docs/', 'index.php'])).toEqual(['docs/']);
  });
});

// A project downloaded from a server brings its .gitignore and no .git.
describe('a project without a repository', () => {
  const root = folderWith({
    '.gitignore': 'vendor/\n*.log\n!keep.log\n/build\n',
    'src/.gitignore': 'cache/\n!important.log\n',
  });

  it('reads .gitignore as git would', async () => {
    expect(
      await ignoredOf(root, ['a.log', 'keep.log', 'vendor/', 'vendor/x.php', 'build/', 'src/build/'])
    ).toEqual(['a.log', 'vendor/', 'vendor/x.php', 'build/']);
  });

  it('applies a nested .gitignore below its own folder only', async () => {
    expect(await ignoredOf(root, ['src/cache/', 'cache/', 'src/important.log', 'src/other.log'])).toEqual([
      'src/cache/',
      'src/other.log',
    ]);
  });
});

it('has no rules where there is nothing to read', async () => {
  expect(await ignoreRulesFor(folderWith({ 'index.php': '' }))).toBeUndefined();
});

describe('finding what is left out below a folder', () => {
  const root = repoWith({ '.gitignore': 'vendor/\n*.log\n' });
  const tree: { [folder: string]: Candidate[] } = {
    [root]: [
      { path: path.join(root, 'vendor'), dir: true },
      { path: path.join(root, 'src'), dir: true },
      { path: path.join(root, 'index.php'), dir: false },
    ],
    [path.join(root, 'src')]: [
      { path: path.join(root, 'src', 'a.php'), dir: false },
      { path: path.join(root, 'src', 'debug.log'), dir: false },
    ],
  };

  it('names an ignored folder once, and never looks inside it', async () => {
    const listed: string[] = [];
    const found = await findIgnored((await ignoreRulesFor(root))!, root, async folder => {
      listed.push(folder);
      return tree[folder] || [];
    });

    expect(found.map(one => path.relative(root, one.path))).toEqual(['vendor', 'src/debug.log']);
    expect(listed).toEqual([root, path.join(root, 'src')]);
  });

  it('counts anything inside a folder found as found', () => {
    const left = new Set([path.join(root, 'vendor')]);
    expect(within(left, path.join(root, 'vendor', 'psr', 'log.php'))).toBe(true);
    expect(within(left, path.join(root, 'vendors.php'))).toBe(false);
  });
});
