import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';
import { extractInto } from '../extract';
import { promoteScript, unpackCommand } from '../remoteScript';
import { packFolderCommand } from '../serverTar';

/**
 * Whether a folder arrives byte for byte, both ways round.
 *
 * The one thing the rest of the tests cannot say. They check the pieces against
 * fakes; this builds an awkward folder on a real disk, runs the real `tar`
 * through a real `sh` - which is what runs on the server, the same program with
 * the same flags - and compares every file by its hash, not its length.
 *
 * What makes the folder awkward is the point: names with spaces, quotes and
 * accents, a name that starts with a dash, a dotfile, an empty file, an empty
 * folder, a symlink, a file too big to arrive in one read, and enough files to
 * take the archive route rather than the one-at-a-time one.
 */

const HERE = /GNU tar/.test(
  (() => {
    try {
      return execFileSync('tar', ['--version'], { encoding: 'utf8' });
    } catch (error) {
      return '';
    }
  })()
)
  ? 'gnu'
  : 'bsd';

function temp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-round-'));
}

function hash(file: string): string {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}

interface Seen {
  files: { [relative: string]: string };
  links: { [relative: string]: string };
  directories: string[];
}

/** Everything under a folder, by hash, so two of them can be compared outright. */
function walk(base: string): Seen {
  const seen: Seen = { files: {}, links: {}, directories: [] };

  const into = (dir: string, prefix: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(full);

      if (stat.isSymbolicLink()) {
        seen.links[relative] = fs.readlinkSync(full);
      } else if (stat.isDirectory()) {
        seen.directories.push(relative);
        into(full, relative);
      } else {
        seen.files[relative] = hash(full);
      }
    }
  };

  into(base, '');
  return seen;
}

/** A folder holding everything that has ever gone wrong with a folder. */
function buildAwkwardTree(): string {
  const root = temp();
  const write = (relative: string, content: string | Buffer, mode?: number) => {
    const full = path.join(root, relative);
    (fs as any).mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    if (mode !== undefined) {
      fs.chmodSync(full, mode);
    }
  };

  write('index.php', '<?php echo "root";');
  write('.hidden', 'a dotfile');
  write('-dash.txt', 'a name that looks like a flag');
  write("it's here.txt", 'a quote and a space');
  write('ümlaut ö.txt', 'not ascii');
  write('empty.txt', '');
  write('private.env', 'SECRET=1', 0o600);
  write('deploy.sh', '#!/bin/sh\nexit 0\n', 0o755);

  // Too big to arrive in one read, and not compressible, so the archive has to
  // carry all of it.
  write('media/big.bin', crypto.randomBytes(3 * 1024 * 1024));

  // Deep, and enough of them that an upload takes the archive route.
  for (let i = 0; i < 120; i += 1) {
    write(`app/views/partials/p${i}.php`, `<?php // ${i}\n`);
  }
  for (let i = 0; i < 120; i += 1) {
    write(`app/models/deep/deeper/m${i}.php`, `<?php class M${i} {}\n`);
  }

  (fs as any).mkdirSync(path.join(root, 'cache/empty'), { recursive: true });
  fs.symlinkSync('index.php', path.join(root, 'current.php'));

  return root;
}

/** The pack command, run for real, as a stream of the archive it makes. */
function packed(dir: string) {
  const child = spawn('/bin/sh', ['-c', packFolderCommand(HERE as any, dir)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child.stdout;
}

function feed(command: string, input: Buffer): Promise<number> {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    child.on('close', code => resolve(code === null ? -1 : code));
    child.stdin.end(input);
  });
}

function runScript(script: string): Promise<number> {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-s'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    child.on('close', code => resolve(code === null ? -1 : code));
    child.stdin.end(script);
  });
}

describe('a folder that goes out and comes back', () => {
  jest.setTimeout(60000);

  it('arrives byte for byte on the way down', async () => {
    const source = buildAwkwardTree();
    const landing = temp();

    const result = await extractInto(packed(source), { localBase: landing });

    const sent = walk(source);
    const arrived = walk(landing);

    // Every file, by hash rather than by length.
    expect(arrived.files).toEqual(sent.files);
    // The link is still a link, pointing where it pointed.
    expect(arrived.links).toEqual(sent.links);
    // Including the folder that holds nothing, which files alone would lose.
    expect(arrived.directories).toEqual(sent.directories);
    expect(result.files).toBe(Object.keys(sent.files).length);
    expect(result.refused).toBe(0);
  });

  it('keeps the times it was given', async () => {
    const source = buildAwkwardTree();
    const landing = temp();
    const when = new Date('2021-06-01T10:20:30Z');
    fs.utimesSync(path.join(source, 'index.php'), when, when);

    await extractInto(packed(source), { localBase: landing });

    const there = fs.statSync(path.join(landing, 'index.php'));
    // To the second: that is what tar carries.
    expect(Math.floor(there.mtime.getTime() / 1000)).toBe(
      Math.floor(when.getTime() / 1000)
    );
  });

  it('arrives byte for byte on the way up, and in place', async () => {
    const source = buildAwkwardTree();
    const target = temp();

    // Something already there, with a mode of its own to keep, and something
    // the archive says nothing about.
    fs.writeFileSync(path.join(target, 'index.php'), 'the old one');
    fs.chmodSync(path.join(target, 'index.php'), 0o640);
    fs.writeFileSync(path.join(target, 'untouched.txt'), 'only here');

    const sent = walk(source);
    const files = Object.keys(sent.files).concat(Object.keys(sent.links));
    const directories = sent.directories;

    const archive = (tar.create(
      {
        gzip: { level: 1 },
        cwd: source,
        follow: false,
        portable: false,
        noDirRecurse: true,
        sync: true,
      } as any,
      files
    ) as any).read() as Buffer;

    const id = 'roundtrip';
    expect(await feed(unpackCommand(target, id), archive)).toBe(0);
    expect(
      await runScript(
        promoteScript({
          target,
          id,
          flavour: HERE as any,
          directories,
          files: Object.keys(sent.files)
            .map(p => ({
              path: p,
              mode:
                fs.statSync(path.join(source, p)).mode & 0o777, // tslint:disable-line:no-bitwise
            }))
            .concat(Object.keys(sent.links).map(p => ({ path: p, mode: undefined } as any))),
        })
      )
    ).toBe(0);

    const arrived = walk(target);

    // Everything that was sent is there, byte for byte.
    Object.keys(sent.files).forEach(relative => {
      expect(arrived.files[relative]).toBe(sent.files[relative]);
    });
    expect(arrived.links).toEqual(sent.links);
    // What the archive said nothing about is still there.
    expect(arrived.files['untouched.txt']).toBeDefined();
    // The file that was already there kept its own mode, and a new one took the
    // mode it came with.
    expect(fs.statSync(path.join(target, 'index.php')).mode & 0o777).toBe(0o640);
    expect(fs.statSync(path.join(target, 'private.env')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(target, 'deploy.sh')).mode & 0o777).toBe(0o755);
    // And nothing of ours is left behind.
    expect(fs.existsSync(path.join(target, `.sftp-archive-${id}`))).toBe(false);
  });
});
