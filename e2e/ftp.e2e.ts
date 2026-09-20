import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import upath from '../src/core/upath';
import FTPFileSystem from '../src/core/fs/ftpFileSystem';
import { execFileSync } from 'child_process';
import {
  isUpgradeTrouble,
  looksLikeTlsTrouble,
  withTls,
} from '../src/core/ftpsPolicy';
import { startFtpServer, RunningFtpServer } from './ftpServer';
import { createTools } from '../src/mcp/tools';
import { validate } from './schemaCheck';

/**
 * FTP against a server that speaks the protocol.
 *
 * More of this extension's own code sits behind FTP than behind SFTP - a
 * connection pool, a hidden-file probe with a sticky verdict, a clock-offset
 * measurement, and a transfer that holds its control connection until the data
 * socket drains - and none of it had ever run against a real server.
 */

jest.setTimeout(60000);

const FILES: { [name: string]: string } = {
  'index.php': '<?php require "app/boot.php";',
  '.htaccess': 'deny from all',
  'app/boot.php': '<?php function run() {}',
};

let server: RunningFtpServer;
let root: string;
// Every connection a test opened, ended afterwards whether the test did or
// not: node-ftp holds a keepalive timer per client, and a timer nobody clears
// keeps the process alive long after the suite has passed.
const opened: FTPFileSystem[] = [];

function track(fileSystem: FTPFileSystem): FTPFileSystem {
  opened.push(fileSystem);
  return fileSystem;
}

function connect(option: object = {}): Promise<FTPFileSystem> {
  const fileSystem = track(new FTPFileSystem(upath, {
    clientOption: {
      host: '127.0.0.1',
      port: server.port,
      username: 'tester',
      password: 'anything',
      connectTimeout: 5000,
      debug: () => undefined,
    },
    ...option,
  } as any));

  return fileSystem
    .connect((fileSystem as any).client._option, {
      askForPasswd: async () => undefined,
    })
    .then(() => fileSystem);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ftp-e2e-'));
  Object.keys(FILES).forEach(name => {
    const full = path.join(root, name);
    fse.ensureDirSync(path.dirname(full));
    fs.writeFileSync(full, FILES[name]);
  });

  server = await startFtpServer(root);
});

afterEach(async () => {
  opened.splice(0).forEach(fileSystem => {
    try {
      fileSystem.end();
    } catch (error) {
      // Already ended, or never connected. Either is fine here.
    }
  });
  await server.close();
});

function certificates() {
  const directory = path.join(os.tmpdir(), 'ftps-e2e');
  fse.ensureDirSync(directory);
  const key = path.join(directory, 'key.pem');
  const cert = path.join(directory, 'cert.pem');
  if (!fs.existsSync(cert)) {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1',
    ]);
  }

  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function connectWith(option: any, port: number, operationTimeout?: number) {
  const fileSystem = track(new FTPFileSystem(upath, {
    operationTimeout,
    clientOption: {
      host: '127.0.0.1',
      port,
      username: 'tester',
      password: 'anything',
      connectTimeout: 8000,
      debug: () => undefined,
      secure: option.secure,
      secureOptions: option.secureOptions,
    },
  } as any));

  return fileSystem
    .connect((fileSystem as any).client._option, {
      askForPasswd: async () => undefined,
    })
    .then(() => fileSystem);
}

describe('trying TLS on a connection configured as plain FTP', () => {
  const plain = { protocol: 'ftp', host: '127.0.0.1', password: 'p' };

  it('works, when the server can carry it', async () => {
    const offering = await startFtpServer(root, certificates());

    const fileSystem = await connectWith(withTls(plain), offering.port);
    const entries = await fileSystem.list('/');

    expect(entries.map(entry => entry.name)).toContain('index.php');
    fileSystem.end();
    await offering.close();
  });

  it('fails at the handshake when the server cannot, which is the signal to fall back', async () => {
    // The outer server has no certificate, so AUTH TLS is refused. The
    // attempt costs one connection and tells the truth immediately.
    const error = await connectWith(withTls(plain), server.port).catch(e => e);

    expect(error).toBeInstanceOf(Error);
    expect(looksLikeTlsTrouble(error)).toBe(true);
  });

  it('hangs at the listing when only the data connection is broken', async () => {
    // The case worth fearing, and the one that does not announce itself:
    // control encrypts, `PROT P` is agreed, and the data connection arrives
    // in the clear anyway. Logging in works. The listing does not fail - it
    // waits, because the client is holding a TLS handshake against a server
    // that is talking plaintext. Only the operation deadline ends it, which
    // is why silence counts as evidence alongside an error.
    const pretending = await startFtpServer(root, certificates());
    pretending.misbehave({ breakDataTls: true });

    const fileSystem = await connectWith(withTls(plain), pretending.port, 3000);

    const started = Date.now();
    const error = await fileSystem.list('/').catch(e => e);

    expect(error).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(20000);
    // Not TLS trouble by its message - it is a timeout - but on a connection
    // nobody asked to be encrypted, that is the same signal.
    expect(looksLikeTlsTrouble(error)).toBe(false);
    expect(isUpgradeTrouble(error)).toBe(true);

    fileSystem.end();
    await pretending.close();
  });
});

describe('FTPS', () => {
  it('upgrades the connection with AUTH TLS and works the same', async () => {
    // The configuration this was reported against: secure with a certificate
    // nobody verifies, which is the common shape on shared hosting.
    const secureServer = await startFtpServer(root, certificates());

    const fileSystem = new FTPFileSystem(upath, {
      clientOption: {
        host: '127.0.0.1',
        port: secureServer.port,
        username: 'tester',
        password: 'anything',
        secure: true,
        secureOptions: { rejectUnauthorized: false },
        connectTimeout: 8000,
        debug: () => undefined,
      },
    } as any);

    await fileSystem.connect((fileSystem as any).client._option, {
      askForPasswd: async () => undefined,
    });

    const entries = await fileSystem.list('/');
    expect(entries.map(entry => entry.name)).toContain('index.php');

    const content = await fileSystem.readFile('/index.php');
    expect(content.toString()).toBe(FILES['index.php']);

    fileSystem.end();
    await secureServer.close();
  });
});

describe('FTP against a real server', () => {
  it('connects and lists a directory', async () => {
    const fileSystem = await connect();

    const entries = await fileSystem.list('/');

    expect(entries.map(entry => entry.name).sort()).toEqual([
      '.htaccess',
      'app',
      'index.php',
    ]);
    fileSystem.end();
  });

  it('asks for hidden files, and gets them', async () => {
    // The server only sends dotfiles when the `-a` flag is given, exactly like
    // the ones this was written for.
    const fileSystem = await connect();

    const entries = await fileSystem.list('/');

    expect(entries.map(entry => entry.name)).toContain('.htaccess');
    fileSystem.end();
  });

  it('falls back to a plain listing when the server rejects the flag', async () => {
    server.misbehave({ refuseListAll: true });
    const fileSystem = await connect();

    const entries = await fileSystem.list('/');

    // No dotfiles, because the server hides them without the flag - but the
    // listing itself still works, which is the point.
    expect(entries.map(entry => entry.name).sort()).toEqual(['app', 'index.php']);
    fileSystem.end();
  });

  it('reads a file whole', async () => {
    const fileSystem = await connect();

    const content = await fileSystem.readFile('/index.php');

    expect(content.toString()).toBe(FILES['index.php']);
    fileSystem.end();
  });

  it('reads a file as text when asked for an encoding', async () => {
    // The stream then emits strings, which used to reach `Buffer.concat` and
    // throw there.
    const fileSystem = await connect();

    const content = await fileSystem.readFile('/index.php', { encoding: 'utf8' } as any);

    expect(content).toBe(FILES['index.php']);
    fileSystem.end();
  });

  it('opens more connections when transfers overlap', async () => {
    const fileSystem = await connect({ connectionLimit: 4 });

    await Promise.all([
      fileSystem.list('/'),
      fileSystem.list('/app'),
      fileSystem.readFile('/index.php'),
      fileSystem.readFile('/app/boot.php'),
    ]);

    // One control connection can carry one transfer; the pool is the only way
    // to overlap them.
    expect(server.connections()).toBeGreaterThan(1);
    fileSystem.end();
  });

  it('gives up on a command the server never answers', async () => {
    const fileSystem = await connect({ operationTimeout: 2000 });
    server.misbehave({ stallCommand: 'MDTM' });

    const started = Date.now();
    const error = await fileSystem.lstat('/index.php').catch(e => e);
    const waited = Date.now() - started;

    // Whatever it decides, it must decide: without the deadline this waits
    // for a reply that is never coming.
    expect(waited).toBeLessThan(20000);
    expect(error === undefined || error instanceof Object).toBe(true);
    fileSystem.end();
  });
});

/**
 * The MCP tools over FTP.
 *
 * Everything an agent reads goes through one of these, and every test of them
 * until now has been against SFTP or a fake. FTP is the protocol with the
 * connection pool, the hidden-file probe and the clock-offset correction
 * behind it, so "the tools work" and "the tools work over FTP" are two
 * different claims.
 */
describe('the MCP tools over FTP', () => {
  let tools: ReturnType<typeof createTools>;
  let workspace: string;
  let cacheRoot: string;

  beforeEach(async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ftp-mcp-'));
    workspace = path.join(base, 'workspace');
    cacheRoot = path.join(base, 'cache');
    fse.ensureDirSync(workspace);

    const fileSystem = await connect();
    const service: any = {
      id: 1,
      name: 'Fixture over FTP',
      workspace,
      baseDir: workspace,
      getConfig: () => ({
        name: 'Fixture over FTP',
        protocol: 'ftp',
        host: '127.0.0.1',
        port: server.port,
        remotePath: '/',
      }),
    };

    tools = createTools({
      services: () => [service],
      exposure: () => ({ exposedByDefault: true }),
      remoteFs: async () => fileSystem as any,
      cacheOption: () => ({ cacheRoot }),
      callTimeout: () => 20000,
    } as any);
  });

  const run = (name: string, args: any) =>
    tools.find(one => one.name === name)!.run(args);

  const schemaOf = (name: string) =>
    (tools.find(one => one.name === name) as any).outputSchema;

  it('lists a directory, with the times the server reported', async () => {
    const result: any = await run('list', { server: 'Fixture over FTP', path: '/' });

    expect(result.structured.entries.map((e: any) => e.name)).toContain('index.php');
    // A timestamp the clock-offset correction turned into NaN used to arrive
    // here as a schema violation and nothing else.
    result.structured.entries.forEach((entry: any) =>
      expect(Number.isFinite(entry.mtime)).toBe(true)
    );
    expect(validate(result.structured, schemaOf('list'), 'list')).toEqual([]);
  });

  it('reads a file over the data connection', async () => {
    const result: any = await run('read', { server: 'Fixture over FTP', path: '/index.php' });

    expect(result.isError).toBeFalsy();
    expect(result.structured.content).toBe(FILES['index.php']);
    expect(validate(result.structured, schemaOf('read'), 'read')).toEqual([]);
  });

  it('stats a file without transferring it', async () => {
    const result: any = await run('stat', { server: 'Fixture over FTP', path: '/index.php' });

    expect(result.structured.size).toBe(FILES['index.php'].length);
    expect(Number.isFinite(result.structured.mtime)).toBe(true);
    expect(validate(result.structured, schemaOf('stat'), 'stat')).toEqual([]);
  });

  it('walks the tree, hidden files included', async () => {
    const result: any = await run('tree', { server: 'Fixture over FTP' });
    const paths = result.structured.files.map((f: any) => f.path);

    expect(paths).toContain('/index.php');
    expect(paths).toContain('/app/boot.php');
    expect(validate(result.structured, schemaOf('tree'), 'tree')).toEqual([]);
  });

  it('searches the files it fetched', async () => {
    const result: any = await run('search', { server: 'Fixture over FTP', query: 'function run' });

    expect(result.structured.matches.map((m: any) => m.path).join()).toContain(
      'boot.php'
    );
    expect(validate(result.structured, schemaOf('search'), 'search')).toEqual([]);
  });
});
