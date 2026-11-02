import * as crypto from 'crypto';
import * as fse from 'fs-extra';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { homeDir } from '../mcp/discovery';

/**
 * How `ssh` in a terminal gets a password without anybody typing it.
 *
 * `SSH_ASKPASS` names a program `ssh` runs for every question it would
 * otherwise ask on the terminal, reading the answer from its output; with
 * `SSH_ASKPASS_REQUIRE=force` it does so even with a terminal there. The
 * program here asks the window that opened the session, over a socket in a
 * directory only this user can enter, with a token only that `ssh` was given.
 *
 * So the password never appears in a command line, an environment, a file or
 * a shell history: it goes from the store to the editor to a pipe into `ssh`.
 * What the environment does carry - the socket and the token - opens nothing
 * once the session is closed or the time is up, and while it is open a stored
 * secret is handed out once; anything after that asks the user.
 */

const LIFETIME = 5 * 60 * 1000;
const MAX_QUESTIONS = 20;

const HELPER_SOURCE = `'use strict';
// Written by the SFTP extension: answers ssh's questions by asking the editor.
var net = require('net');
var socket = net.connect(process.env.SFTP_ASKPASS_HANDLE || '');
var received = '';
socket.setEncoding('utf8');
socket.on('connect', function () {
  socket.write(JSON.stringify({
    token: process.env.SFTP_ASKPASS_TOKEN || '',
    prompt: process.argv[2] || ''
  }) + '\\n');
});
socket.on('data', function (chunk) {
  received += chunk;
  var end = received.indexOf('\\n');
  if (end === -1) return;
  var reply = {};
  try { reply = JSON.parse(received.slice(0, end)); } catch (e) {}
  socket.destroy();
  if (typeof reply.answer === 'string') {
    process.stdout.write(reply.answer + '\\n', function () { process.exit(0); });
  } else {
    process.exit(1);
  }
});
socket.on('error', function () { process.exit(1); });
`;

// `SSH_ASKPASS` takes a program and no arguments, so the editor's own runtime
// is reached through a script - which needs no node installed.
const WRAPPER_SOURCE = `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "$SFTP_ASKPASS_NODE" "$SFTP_ASKPASS_MAIN" "$@"
`;

export const askpassHelperPath = () => path.join(homeDir(), 'ssh-askpass.js');
export const askpassWrapperPath = () => path.join(homeDir(), 'ssh-askpass.sh');

/** Rewritten every time, so an updated extension brings an updated helper. */
async function installHelper(): Promise<void> {
  await fse.ensureDir(homeDir());
  await fse.writeFile(askpassHelperPath(), HELPER_SOURCE, { encoding: 'utf8', mode: 0o700 });
  await fse.writeFile(askpassWrapperPath(), WRAPPER_SOURCE, { encoding: 'utf8', mode: 0o700 });
  // `mode` applies only to a file being created.
  await fse.chmod(askpassWrapperPath(), 0o700);
}

export interface Askpass {
  /** For the `ssh` process, and nothing else. */
  env: { [key: string]: string };
  dispose(): void;
}

function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== 'string' || given.length !== token.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

/**
 * Opens the way in for one `ssh`, answering its questions with `answer`.
 *
 * `runtime` is what runs the helper: the editor's own executable, in node
 * mode, unless a test says otherwise.
 */
export async function startAskpass(
  answer: (prompt: string) => Promise<string | undefined>,
  option: { runtime?: string; lifetime?: number } = {}
): Promise<Askpass> {
  await installHelper();

  // mkdtemp makes it 0700: nobody else can reach the socket inside.
  const dir = await fse.mkdtemp(path.join(os.tmpdir(), 'sftp-ssh-'));
  const handle = path.join(dir, 's');
  const token = crypto.randomBytes(32).toString('hex');
  let questions = 0;

  const server = net.createServer(socket => {
    let received = '';
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.on('data', async chunk => {
      received += chunk;
      const end = received.indexOf('\n');
      if (end === -1) {
        if (received.length > 64 * 1024) {
          socket.destroy();
        }
        return;
      }

      let reply: { answer?: string } = {};
      try {
        const question = JSON.parse(received.slice(0, end));
        received = '';
        questions += 1;
        if (sameToken(question.token, token) && questions <= MAX_QUESTIONS) {
          const given = await answer(String(question.prompt || ''));
          if (given !== undefined) {
            reply = { answer: given };
          }
        }
      } catch (error) {
        reply = {};
      }
      if (!socket.destroyed) {
        socket.end(JSON.stringify(reply) + '\n');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(handle, () => resolve());
  });

  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearTimeout(timer);
    server.close();
    fse.remove(dir).catch(() => undefined);
  };
  const timer = setTimeout(dispose, option.lifetime || LIFETIME);

  return {
    env: {
      SSH_ASKPASS: askpassWrapperPath(),
      SSH_ASKPASS_REQUIRE: 'force',
      SFTP_ASKPASS_NODE: option.runtime || process.execPath,
      SFTP_ASKPASS_MAIN: askpassHelperPath(),
      SFTP_ASKPASS_HANDLE: handle,
      SFTP_ASKPASS_TOKEN: token,
    },
    dispose,
  };
}
