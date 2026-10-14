import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { FileType } from '../fs/fileSystem';
import { aheadOnServer } from '../aheadOnServer';

/**
 * The clockwork case, end to end on git's side: a commit from weeks ago, a
 * server that has since been given newer files from a folder that never
 * committed them, and a checkout made from the old commit about to catch the
 * server up.
 */

let checkout: string;
let server: { [remote: string]: { content: string; mtime: number } };
const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' });

function remoteFs() {
  return {
    lstat: async (remote: string) => {
      const one = server[remote];
      if (!one) {
        throw Object.assign(new Error('No such file'), { code: 2 });
      }
      return { type: FileType.File, size: Buffer.byteLength(one.content), mtime: one.mtime };
    },
    readFile: async (remote: string) => Buffer.from(server[remote].content),
  };
}

const at = (relative: string) => path.join(checkout, relative);
const remotePathOf = (file: string) => `/httpdocs/${path.relative(checkout, file)}`;

beforeEach(() => {
  checkout = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ahead-')));
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fse.outputFileSync(at('assets/week.js'), 'week, as committed');
  fse.outputFileSync(at('index.php'), 'index, as committed');
  git('add', '-A');
  git('commit', '-qm', 'weeks ago');

  server = {
    '/httpdocs/assets/week.js': { content: 'week, edited and deployed, never committed', mtime: 0 },
    '/httpdocs/index.php': { content: 'index, as committed', mtime: 0 },
  };

  // The checkout's own work on top of the old commit.
  fse.outputFileSync(at('assets/week.js'), 'week, the agent’s version');
  fse.outputFileSync(at('index.php'), 'index, the agent’s version');
  fse.outputFileSync(at('includes/New.php'), 'new');
});

afterEach(() => fse.removeSync(checkout));

describe('what the server has newer than a catch-up assumes', () => {
  const files = () => [at('assets/week.js'), at('index.php'), at('includes/New.php')];

  it('is the file deployed without being committed, and only that', async () => {
    const ahead = await aheadOnServer({
      remoteFs: remoteFs(),
      checkout,
      base: 'HEAD',
      files: files(),
      remotePathOf,
    });

    expect(ahead).toEqual([at('assets/week.js')]);
  });

  // Same size, different bytes: sizes alone would have let it through.
  it('is caught when only the content differs', async () => {
    server['/httpdocs/index.php'].content = 'index, as COMMITTED';

    const ahead = await aheadOnServer({
      remoteFs: remoteFs(),
      checkout,
      base: 'HEAD',
      files: [at('index.php')],
      remotePathOf,
    });

    expect(ahead).toEqual([at('index.php')]);
  });

  it('includes a file the server has and the base never did', async () => {
    server['/httpdocs/includes/New.php'] = { content: 'someone else’s', mtime: 0 };

    const ahead = await aheadOnServer({
      remoteFs: remoteFs(),
      checkout,
      base: 'HEAD',
      files: [at('includes/New.php')],
      remotePathOf,
    });

    expect(ahead).toEqual([at('includes/New.php')]);
  });

  it('goes by time when there is no revision to compare with', async () => {
    const localTime = fs.statSync(at('index.php')).mtimeMs;
    server['/httpdocs/assets/week.js'].mtime = localTime + 60 * 1000;
    server['/httpdocs/index.php'].mtime = localTime - 60 * 1000;

    const ahead = await aheadOnServer({
      remoteFs: remoteFs(),
      checkout,
      files: [at('assets/week.js'), at('index.php')],
      remotePathOf,
    });

    expect(ahead).toEqual([at('assets/week.js')]);
  });
});
