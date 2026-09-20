import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import upath from '../src/core/upath';
import FTPFileSystem from '../src/core/fs/ftpFileSystem';
import { execFileSync } from 'child_process';
import { probeFtps, Support, withTls } from '../src/core/ftpsProbe';
import { startFtpServer, RunningFtpServer } from './ftpServer';

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

function connect(option: object = {}): Promise<FTPFileSystem> {
  const fileSystem = new FTPFileSystem(upath, {
    clientOption: {
      host: '127.0.0.1',
      port: server.port,
      username: 'tester',
      password: 'anything',
      connectTimeout: 5000,
      debug: () => undefined,
    },
    ...option,
  } as any);

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
  await server.close();
});

describe('finding out whether a plain server would rather speak TLS', () => {
  it('sees the offer, and takes it', async () => {
    const certificates = path.join(os.tmpdir(), 'ftps-e2e');
    fse.ensureDirSync(certificates);
    const key = path.join(certificates, 'key.pem');
    const cert = path.join(certificates, 'cert.pem');
    if (!fs.existsSync(cert)) {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1',
      ]);
    }

    const offering = await startFtpServer(root, {
      key: fs.readFileSync(key),
      cert: fs.readFileSync(cert),
    });

    const support = await probeFtps({ host: '127.0.0.1', port: offering.port });
    expect(support).toBe(Support.Tls);

    // The configuration says plain FTP; what actually connects is FTPS.
    const option = withTls(
      { protocol: 'ftp', host: '127.0.0.1', port: offering.port, password: 'p' },
      support
    );
    expect(option.secure).toBe(true);

    const fileSystem = new FTPFileSystem(upath, {
      clientOption: {
        host: '127.0.0.1',
        port: offering.port,
        username: 'tester',
        password: 'anything',
        secure: option.secure,
        secureOptions: option.secureOptions,
        connectTimeout: 8000,
        debug: () => undefined,
      },
    } as any);

    await fileSystem.connect((fileSystem as any).client._option, {
      askForPasswd: async () => undefined,
    });

    expect((await fileSystem.list('/')).map(entry => entry.name)).toContain(
      'index.php'
    );

    fileSystem.end();
    await offering.close();
  });

  it('leaves a server that cannot do it alone', async () => {
    // The plain server from the outer fixture advertises no AUTH TLS.
    const support = await probeFtps({ host: '127.0.0.1', port: server.port });

    expect(support).toBe(Support.None);
    const option = { protocol: 'ftp', host: '127.0.0.1', password: 'p' };
    expect(withTls(option, support)).toBe(option);
  });
});

describe('FTPS', () => {
  it('upgrades the connection with AUTH TLS and works the same', async () => {
    // The configuration this was reported against: secure with a certificate
    // nobody verifies, which is the common shape on shared hosting.
    const certificates = path.join(os.tmpdir(), 'ftps-e2e');
    fse.ensureDirSync(certificates);
    const key = path.join(certificates, 'key.pem');
    const cert = path.join(certificates, 'cert.pem');
    if (!fs.existsSync(cert)) {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1',
      ]);
    }

    const secureServer = await startFtpServer(root, {
      key: fs.readFileSync(key),
      cert: fs.readFileSync(cert),
    });

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
