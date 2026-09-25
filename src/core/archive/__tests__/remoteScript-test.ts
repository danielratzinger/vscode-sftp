import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';
import {
  promoteScript,
  stagingPath,
  unpackCommand,
} from '../remoteScript';

const ID = 'ab12cd34';

/**
 * Runs what the server would run, in this machine's shell.
 *
 * Worth doing rather than only matching strings: it is a real sh, a real tar
 * and a real find, and this is the one part of the transfer that is written in
 * a language nothing here type-checks.
 */
function run(script: string, input?: Buffer): number {
  try {
    execFileSync('/bin/sh', ['-s'], {
      input: input === undefined ? script : input,
      env: { ...process.env, SCRIPT: script },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    return 0;
  } catch (error) {
    return error.status === undefined ? -1 : error.status;
  }
}

function runCommand(command: string, input: Buffer): number {
  try {
    execFileSync('/bin/sh', ['-c', command], {
      input,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    return 0;
  } catch (error) {
    return error.status === undefined ? -1 : error.status;
  }
}

function temp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-archive-'));
}

function modeOf(file: string): number {
  return fs.statSync(file).mode & 0o777; // tslint:disable-line:no-bitwise
}

/** The flavour this machine actually has, so the script that runs is the right one. */
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

describe('where the staging folder goes', () => {
  it('sits inside the target, so a move is a rename', () => {
    expect(stagingPath('/var/www/site', ID)).toBe(
      '/var/www/site/.sftp-archive-ab12cd34'
    );
  });

  it('does not double the slash on a target that ends in one', () => {
    expect(stagingPath('/var/www/site/', ID)).toBe(
      '/var/www/site/.sftp-archive-ab12cd34'
    );
  });
});

describe('the commands, as text', () => {
  it('leaves a shell nothing to read in a target that looks like a command', () => {
    const where = temp();
    const pwned = path.join(where, 'pwned');
    // A folder name that is also an instruction, if anything lets it be one.
    const target = `${where}/it's; touch ${pwned}`;

    // The command fails, because there is no such folder - but only that.
    runCommand(unpackCommand(target, ID), Buffer.from(''));

    expect(fs.existsSync(pwned)).toBe(false);
  });

  it('clears up after a dropped connection, not after itself', () => {
    // The staging folder has to outlive this command: the script that moves the
    // files comes next.
    expect(unpackCommand('/srv', ID)).toContain(`trap 'rm -rf -- "$S"' INT TERM HUP`);
    expect(unpackCommand('/srv', ID)).not.toContain('EXIT');
  });

  it('sweeps what an earlier upload left behind', () => {
    expect(unpackCommand('/srv', ID)).toContain(`-name '.sftp-archive-*'`);
    expect(unpackCommand('/srv', ID)).toContain('-mtime +0');
  });

  it('never lets a uid from this machine follow the files', () => {
    expect(unpackCommand('/srv', ID)).toContain('--no-same-owner');
  });

  it('keeps Apple metadata out of the unpacking too', () => {
    expect(unpackCommand('/srv', ID)).toContain('COPYFILE_DISABLE=1 tar');
  });

  it('asks GNU and the other one for the target mode in their own words', () => {
    const forGnu = promoteScript({
      target: '/srv',
      id: ID,
      flavour: 'gnu',
      directories: [],
      files: [{ path: 'a.php', mode: 0o644 }],
    });
    const forBsd = promoteScript({
      target: '/srv',
      id: ID,
      flavour: 'bsd',
      directories: [],
      files: [{ path: 'a.php', mode: 0o644 }],
    });

    expect(forGnu).toContain(`chmod --reference='/srv/a.php'`);
    expect(forBsd).toContain(`stat -f '%Lp' '/srv/a.php'`);
  });

  it('uses the configured mode instead of asking, when there is one', () => {
    const script = promoteScript({
      target: '/srv',
      id: ID,
      flavour: 'gnu',
      directories: ['app'],
      files: [{ path: 'a.php', mode: 0o644 }],
      filePerm: 0o640,
      dirPerm: 0o750,
    });

    expect(script).toContain('chmod 640 --');
    expect(script).toContain('chmod 750 --');
    expect(script).not.toContain('--reference');
  });

  it('clears the staging folder however it ends', () => {
    const script = promoteScript({
      target: '/srv',
      id: ID,
      flavour: 'gnu',
      directories: [],
      files: [],
    });

    expect(script).toContain(`trap 'rm -rf -- "$S"' EXIT INT TERM HUP`);
    expect(script).toContain('exit $f');
  });
});

describe('the commands, run', () => {
  it('unpacks and puts every file where it belongs', () => {
    const source = temp();
    fs.mkdirSync(path.join(source, 'app'));
    fs.writeFileSync(path.join(source, 'index.php'), 'new index');
    fs.writeFileSync(path.join(source, 'app/boot.php'), 'new boot');

    const target = temp();
    fs.writeFileSync(path.join(target, 'index.php'), 'old index');
    fs.chmodSync(path.join(target, 'index.php'), 0o640);
    fs.writeFileSync(path.join(target, 'untouched.txt'), 'only here');

    const archive = tar.create(
      { gzip: true, cwd: source, sync: true } as any,
      ['index.php', 'app/boot.php']
    ).read() as Buffer;

    expect(runCommand(unpackCommand(target, ID), archive)).toBe(0);
    expect(
      fs.existsSync(path.join(target, `.sftp-archive-${ID}/app/boot.php`))
    ).toBe(true);

    const script = promoteScript({
      target,
      id: ID,
      flavour: HERE as any,
      directories: ['app'],
      files: [
        { path: 'index.php', mode: 0o600 },
        { path: 'app/boot.php', mode: 0o644 },
      ],
    });

    expect(run(script)).toBe(0);

    // What the archive held is in place.
    expect(fs.readFileSync(path.join(target, 'index.php'), 'utf8')).toBe('new index');
    expect(fs.readFileSync(path.join(target, 'app/boot.php'), 'utf8')).toBe('new boot');
    // What it said nothing about is left alone.
    expect(fs.readFileSync(path.join(target, 'untouched.txt'), 'utf8')).toBe('only here');
    // A file already there keeps its own mode; a new one gets the one it came with.
    expect(modeOf(path.join(target, 'index.php'))).toBe(0o640);
    expect(modeOf(path.join(target, 'app/boot.php'))).toBe(0o644);
    // And nothing of ours is left behind.
    expect(fs.existsSync(path.join(target, `.sftp-archive-${ID}`))).toBe(false);
  });

  it('counts what it could not move and says so in the exit code', () => {
    const target = temp();
    const staging = stagingPath(target, ID);
    fs.mkdirSync(staging);
    // Nothing staged under this name, so the move has nothing to move.
    const script = promoteScript({
      target,
      id: ID,
      flavour: HERE as any,
      directories: [],
      files: [{ path: 'missing.php', mode: 0o644 }],
    });

    expect(run(script)).toBe(1);
    expect(fs.existsSync(staging)).toBe(false);
  });

  it('leaves the staging folder behind for the next sweep, not for ever', () => {
    const target = temp();
    const stale = path.join(target, '.sftp-archive-oldone');
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, 'left.txt'), 'x');
    // Two days old, which is what the sweep looks for.
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    fs.utimesSync(stale, old, old);

    const source = temp();
    fs.writeFileSync(path.join(source, 'one.txt'), 'x');
    const archive = tar
      .create({ gzip: true, cwd: source, sync: true } as any, ['one.txt'])
      .read() as Buffer;
    expect(runCommand(unpackCommand(target, ID), archive)).toBe(0);

    expect(fs.existsSync(stale)).toBe(false);
  });
});
