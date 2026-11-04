import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Server } from 'ssh2';
import { AskpassAnswers, sshCommandLine } from '../src/core/sshSession';
import { startAskpass, askpassHelperPath, askpassWrapperPath } from '../src/modules/sshAskpass';
import { usableHostKey } from './sftpServer';

/**
 * `Open SSH Session` end to end: the system's own `ssh`, run the way the
 * terminal runs it, against a server that takes one password and nothing
 * else - with the answers coming through the real helper and socket.
 */

jest.setTimeout(30000);

const PASSWORD = `S3cret 'pass' $word`;

let home: string;
let server: any;
let port: number;
const offered: string[] = [];
const ran: string[] = [];

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-session-e2e-'));
  process.env.VSCODE_SFTP_HOME = home;

  const keys = usableHostKey();
  server = new Server({ hostKeys: [keys.private] }, (client: any) => {
    client.on('error', () => undefined);
    client.on('authentication', (ctx: any) => {
      if (ctx.method !== 'password') {
        return ctx.reject(['password']);
      }
      offered.push(ctx.password);
      return ctx.password === PASSWORD ? ctx.accept() : ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (acceptSession: any) => {
        const session = acceptSession();
        session.on('pty', (accept: any) => accept && accept());
        session.on('exec', (accept: any, _reject: any, info: any) => {
          ran.push(info.command);
          const stream = accept();
          stream.write('logged in\n');
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  delete process.env.VSCODE_SFTP_HOME;
});

beforeEach(() => {
  offered.length = 0;
  ran.length = 0;
});

/** Runs the line the command builds, as the terminal would, and waits for ssh to end. */
function runSsh(env: { [key: string]: string }, knownHosts: string) {
  const line = sshCommandLine(
    { host: '127.0.0.1', port, username: 'deploy' },
    '/srv/my app',
    [
      '-F', '/dev/null',
      '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', 'StrictHostKeyChecking=ask',
      '-o', 'PubkeyAuthentication=no',
      '-o', 'NumberOfPasswordPrompts=3',
    ]
  );
  const child = spawn('/bin/sh', ['-c', `exec ${line}`], {
    env: { ...process.env, SSH_AUTH_SOCK: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', chunk => (out += chunk));
  child.stderr.on('data', chunk => (out += chunk));
  return new Promise<{ code: number; out: string }>(resolve =>
    child.on('close', code => resolve({ code: code as number, out }))
  );
}

function knownHostsFile(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kh-')), 'known_hosts');
  fs.writeFileSync(file, '');
  return file;
}

function answering(stored: string | undefined, typed: string | undefined, log: string[]) {
  return new AskpassAnswers({
    password: async () => stored,
    passphrase: async () => undefined,
    ask: async prompt => {
      log.push(`ask: ${prompt}`);
      return typed;
    },
    confirm: async prompt => {
      log.push(`confirm: ${prompt.split('\n').pop()}`);
      return true;
    },
  });
}

it('logs in with the stored password, in the folder it was opened on', async () => {
  const log: string[] = [];
  const answers = answering(PASSWORD, undefined, log);
  const askpass = await startAskpass(prompt => answers.answer(prompt), {
    runtime: process.execPath,
  });

  const result = await runSsh(askpass.env, knownHostsFile());
  askpass.dispose();

  expect(result.out).toContain('logged in');
  expect(result.code).toBe(0);
  expect(offered).toEqual([PASSWORD]);
  expect(ran).toEqual([`cd '/srv/my app'; exec $SHELL -l`]);
  // The new host key was put to the user, and nothing else was asked.
  expect(log).toEqual([expect.stringMatching(/^confirm: .*continue connecting/)]);
  // Neither the line nor the environment ssh ran with holds the password.
  expect(JSON.stringify(askpass.env)).not.toContain(PASSWORD);
});

it('asks the user once the stored password is refused, and sends that one', async () => {
  const log: string[] = [];
  const answers = answering('out-of-date', PASSWORD, log);
  const askpass = await startAskpass(prompt => answers.answer(prompt), {
    runtime: process.execPath,
  });

  const result = await runSsh(askpass.env, knownHostsFile());
  askpass.dispose();

  expect(result.code).toBe(0);
  expect(offered).toEqual(['out-of-date', PASSWORD]);
  expect(log[1]).toMatch(/^ask: The stored password was not accepted\. .*password/);
});

it('gives nothing to a caller without the token, or after the session is closed', async () => {
  let asked = 0;
  const askpass = await startAskpass(
    async () => {
      asked += 1;
      return PASSWORD;
    },
    { runtime: process.execPath }
  );

  // Asynchronously: the socket it talks to is served by this very process.
  const helper = (env: { [key: string]: string }) =>
    new Promise<string>(resolve =>
      execFile(
        askpassWrapperPath(),
        [`deploy@host's password: `],
        { env: { ...process.env, ...env } },
        (error: any, stdout) => resolve(error ? `exit ${error.code}` : stdout.toString())
      )
    );

  expect(await helper({ ...askpass.env, SFTP_ASKPASS_TOKEN: 'f'.repeat(64) })).toBe('exit 1');
  expect(asked).toBe(0);
  expect(await helper(askpass.env)).toBe(`${PASSWORD}\n`);

  askpass.dispose();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(await helper(askpass.env)).toBe('exit 1');
  expect(asked).toBe(1);
});

it('keeps the helper and its directory to this user', async () => {
  const askpass = await startAskpass(async () => undefined, { runtime: process.execPath });

  expect(fs.statSync(askpassWrapperPath()).mode.toString(8).slice(-3)).toBe('700');
  expect(fs.statSync(askpassHelperPath()).mode.toString(8).slice(-3)).toBe('700');
  expect(fs.statSync(path.dirname(askpass.env.SFTP_ASKPASS_HANDLE)).mode.toString(8).slice(-3)).toBe('700');
  askpass.dispose();
});
