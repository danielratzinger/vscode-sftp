import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { blobAt, blobIdOf } from '../gitBlob';

let root: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-blob-')));
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fse.outputFileSync(path.join(root, 'assets/week.js'), 'committed');
  git('add', '-A');
  git('commit', '-qm', 'base');
});

afterEach(() => fse.removeSync(root));

describe('a file as git has it at a revision', () => {
  it('is its blob and size', async () => {
    const blob = await blobAt(root, 'HEAD', 'assets/week.js');
    expect(blob && blob.size).toBe('committed'.length);
  });

  it('is nothing when the revision does not have it', async () => {
    expect(await blobAt(root, 'HEAD', 'assets/new.js')).toBeUndefined();
  });

  // What the server has is compared with what the base had.
  it('matches the same bytes and not others', async () => {
    const blob = (await blobAt(root, 'HEAD', 'assets/week.js'))!;

    expect(await blobIdOf(root, Buffer.from('committed'))).toBe(blob.id);
    expect(await blobIdOf(root, Buffer.from('deployed from a folder'))).not.toBe(blob.id);
  });

  // The clockwork case: changes deployed without being committed.
  it('tells an uncommitted change from the commit', async () => {
    fse.outputFileSync(path.join(root, 'assets/week.js'), 'edited and deployed');
    const blob = (await blobAt(root, 'HEAD', 'assets/week.js'))!;

    expect(await blobIdOf(root, fs.readFileSync(path.join(root, 'assets/week.js')))).not.toBe(
      blob.id
    );
  });
});
