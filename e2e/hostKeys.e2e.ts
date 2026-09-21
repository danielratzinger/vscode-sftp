import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import upath from '../src/core/upath';
import SFTPFileSystem from '../src/core/fs/sftpFileSystem';
import { setHostKeyChecker } from '../src/core/remote-client/hostKeys';
import { fingerprintOf, judge, keysFor } from '../src/core/knownHosts';
import { startSftpServer, RunningServer } from './sftpServer';

/**
 * Host key checking, against a server that really presents one.
 *
 * Everything else about this is reasoning: whether the parser reads
 * `known_hosts`, whether the verdict logic is right. The part that can only be
 * settled by running it is whether the key ssh2 hands the verifier is the same
 * key that goes in the file - if those disagree by a byte, every connection
 * either asks for ever or trusts anything, and unit tests would say it was
 * fine either way.
 *
 * So: a real server, a real handshake, and the three answers that matter.
 */

jest.setTimeout(30000);

let server: RunningServer;
let root: string;

function connectTo(port: number): Promise<SFTPFileSystem> {
  const fileSystem = new SFTPFileSystem(upath, {
    clientOption: {
      host: '127.0.0.1',
      port,
      username: 'tester',
      password: 'anything',
      connectTimeout: 8000,
      debug: () => undefined,
    } as any,
    operationTimeout: 3000,
  } as any);

  return fileSystem
    .connect((fileSystem as any).client._option, {
      askForPasswd: async () => undefined,
    })
    .then(() => fileSystem);
}

/**
 * A checker that answers synchronously, as the real one must.
 *
 * `decide` returning a boolean there and then is the whole point: an `await`
 * inside it leaves ssh2 holding the old decipher when `EXT_INFO` arrives.
 */
function watching(decide: (key: Buffer) => boolean): void {
  setHostKeyChecker({
    prepare: async () => undefined,
    decide: (host, port, key) => decide(key),
    askAgain: async () => false,
  });
}

/** The server's key as a `known_hosts` line would carry it. */
function lineFor(host: string, port: number, publicKey: string): string {
  const name = port === 22 ? host : `[${host}]:${port}`;
  return `${name} ${publicKey}\n`;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-hostkey-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  server = await startSftpServer(root);
});

afterEach(async () => {
  setHostKeyChecker(undefined);
  await server.close();
});

describe('the key the server presents', () => {
  it('is the same bytes that go in known_hosts', async () => {
    // The whole point of running this against a real server. `publicKey` is
    // what would be written to the file; `offered` is what ssh2 hands the
    // verifier mid-handshake. If these ever differ, nothing above works.
    let offered: Buffer | undefined;

    watching(key => {
      offered = key;
      return true;
    });

    const fileSystem = await connectTo(server.port);
    await fileSystem.end();

    expect(offered).toBeDefined();

    const known = keysFor(
      lineFor('127.0.0.1', server.port, server.publicKey),
      '127.0.0.1',
      server.port
    );

    expect(known).toHaveLength(1);
    expect(judge(known, offered!)).toBe('trusted');
  });

  it('has a fingerprint in the form people compare', async () => {
    let print = '';
    watching(key => {
      print = fingerprintOf(key);
      return true;
    });

    const fileSystem = await connectTo(server.port);
    await fileSystem.end();

    expect(print).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});

describe('what the answer does to the connection', () => {
  it('connects when the key is accepted', async () => {
    watching(() => true);

    const fileSystem = await connectTo(server.port);
    expect(await fileSystem.readFile('/a.txt')).toBeDefined();
    await fileSystem.end();
  });

  it('refuses to connect when it is not', async () => {
    // No password is sent, because the handshake never gets that far.
    watching(() => false);

    await expect(connectTo(server.port)).rejects.toThrow();
  });

  it('still connects when nothing is checking, as it always did', async () => {
    setHostKeyChecker(undefined);

    const fileSystem = await connectTo(server.port);
    await fileSystem.end();
  });
});

describe('a server whose key changed', () => {
  it('is told apart from one that was never seen', async () => {
    // The distinction the whole feature rests on: `unknown` is ordinary and
    // gets a question, `changed` is the thing worth stopping for.
    const first = server.publicKey;
    const port = server.port;

    await server.close();
    const impostor = await startSftpServer(root, { port });
    server = impostor;

    let offered: Buffer | undefined;
    watching(key => {
      offered = key;
      return true;
    });

    const fileSystem = await connectTo(port);
    await fileSystem.end();

    const onRecord = keysFor(lineFor('127.0.0.1', port, first), '127.0.0.1', port);

    expect(impostor.publicKey).not.toBe(first);
    expect(judge(onRecord, offered!)).toBe('changed');
  });

  it('is trusted again once the stored key is updated', async () => {
    const port = server.port;
    await server.close();
    server = await startSftpServer(root, { port });

    let offered: Buffer | undefined;
    watching(key => {
      offered = key;
      return true;
    });

    const fileSystem = await connectTo(port);
    await fileSystem.end();

    // What "Update the stored key" leaves behind.
    const updated = keysFor(
      lineFor('127.0.0.1', port, server.publicKey),
      '127.0.0.1',
      port
    );

    expect(judge(updated, offered!)).toBe('trusted');
  });

  it('presents the same key again when it restarts with it', async () => {
    const { port, privateKey, publicKey } = server;

    await server.close();
    server = await startSftpServer(root, { port, privateKey });

    expect(server.publicKey).toBe(publicKey);

    let offered: Buffer | undefined;
    watching(key => {
      offered = key;
      return true;
    });

    const fileSystem = await connectTo(port);
    await fileSystem.end();

    const onRecord = keysFor(lineFor('127.0.0.1', port, publicKey), '127.0.0.1', port);
    expect(judge(onRecord, offered!)).toBe('trusted');
  });
});
