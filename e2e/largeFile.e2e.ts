import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import upath from '../src/core/upath';
import SFTPFileSystem from '../src/core/fs/sftpFileSystem';
import FTPFileSystem from '../src/core/fs/ftpFileSystem';
import { createTools, ToolContext } from '../src/mcp/tools';
import { startSftpServer, RunningServer } from './sftpServer';
import { startFtpServer, RunningFtpServer } from './ftpServer';

/**
 * A log far over the size limit, read in part over both protocols.
 *
 * The point of reading a piece is not fetching the rest, so what crossed the
 * wire is counted, not assumed. FTP has a second thing to get right: a
 * transfer let go of before its end leaves the connection mid-reply, and the
 * pool must not hand that connection to the next command.
 */

jest.setTimeout(60000);

const LIMIT = 256 * 1024;
const LINES = 40000;
const KEY_AT = 39990;

/** Line n says which it is, so any slice can be checked against its number. */
function lineFor(n: number): string {
  if (n === 20000) {
    return `${n} download order=4711 needle-in-the-middle`;
  }
  if (n === KEY_AT) {
    return '-----BEGIN PRIVATE KEY-----';
  }
  if (n > KEY_AT && n < KEY_AT + 3) {
    return `MIIEvQIBADANBgkqhkiG9w0BAQEFAASC${n}secretkeymaterial`;
  }
  if (n === KEY_AT + 3) {
    return '-----END PRIVATE KEY-----';
  }
  return `${n} GET /downloads/file-${n}.zip 200 ${'.'.repeat(50)}`;
}

const LOG = Array.from({ length: LINES }, (_, i) => lineFor(i + 1)).join('\n') + '\n';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'large-file-e2e-'));
  fs.writeFileSync(path.join(root, 'download.log'), LOG);
  fs.writeFileSync(path.join(root, 'small.txt'), 'small\n');
});

const service: any = {
  id: 1,
  name: 'Stage',
  workspace: '/nowhere',
  baseDir: '/nowhere',
  getConfig: () => ({ name: 'Stage', protocol: 'sftp', host: '127.0.0.1', remotePath: '/' }),
};

/** The real file system, with every byte a stream delivers counted. */
function counted(fileSystem: any) {
  const seen = { bytes: 0 };
  const remote = {
    list: (dir: string) => fileSystem.list(dir),
    lstat: (p: string) => fileSystem.lstat(p),
    readFile: (p: string) => fileSystem.readFile(p),
    get: async (p: string, option?: any) => {
      const stream = await fileSystem.get(p, option);
      stream.on('data', (chunk: Buffer) => (seen.bytes += chunk.length));
      return stream;
    },
  };
  return { remote, seen };
}

function toolsOver(remote: any, cacheRoot: string) {
  const context: ToolContext = {
    services: () => [service],
    exposure: () => ({ exposedByDefault: true }),
    remoteFs: async () => remote,
    cacheOption: () => ({ cacheRoot, materialize: false }),
    maxFileBytes: () => LIMIT,
    callTimeout: () => 30000,
  } as any;
  const tools = createTools(context);
  return (name: string, args: any) =>
    tools.find(t => t.name === name)!.run({ server: 'Stage', ...args });
}

function behavesLikeALargeFileReader(connect: () => Promise<any>) {
  let fileSystem: any;
  let seen: { bytes: number };
  let run: (name: string, args: any) => Promise<any>;

  beforeAll(async () => {
    fileSystem = await connect();
    const wrapped = counted(fileSystem);
    seen = wrapped.seen;
    run = toolsOver(wrapped.remote, fs.mkdtempSync(path.join(os.tmpdir(), 'large-cache-')));
  });

  afterAll(() => {
    fileSystem.end();
  });

  beforeEach(() => {
    seen.bytes = 0;
  });

  it('points a read of the whole file at the ways to read part of it', async () => {
    const result = await run('read', { path: '/download.log' });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/tail: 200/);
    expect(result.text).toMatch(/start_line/);
    expect(seen.bytes).toBe(0);
  });

  it('hands back the last lines, fetching only the end', async () => {
    const result = await run('read', { path: '/download.log', tail: 3 });

    expect(result.isError).toBeFalsy();
    expect(result.structured.content).toBe(
      [lineFor(LINES - 2), lineFor(LINES - 1), lineFor(LINES)].join('\n')
    );
    expect(seen.bytes).toBeLessThanOrEqual(64 * 1024);
  });

  it('never shows the inside of a key the tail starts in the middle of', async () => {
    // Starts two lines into the key: an END with no BEGIN before it.
    const result = await run('read', { path: '/download.log', tail: LINES - KEY_AT - 1 });

    expect(result.structured.content).not.toMatch(/secretkeymaterial/);
    expect(result.structured.content).toContain(lineFor(LINES));
    expect(result.structured.redacted).toContain('private-key');
  });

  it('reads a range near the top, numbered as the file has it, and stops there', async () => {
    const result = await run('read', { path: '/download.log', start_line: 100, end_line: 102 });

    expect(result.structured.content).toBe(
      [100, 101, 102].map(n => `${n}\t${lineFor(n)}`).join('\n')
    );
    expect(seen.bytes).toBeLessThan(LOG.length / 4);
  });

  it('stops a range at the limit and says where to carry on', async () => {
    const result = await run('read', { path: '/download.log', start_line: 1 });

    expect(Buffer.byteLength(result.structured.content)).toBeLessThan(LIMIT + 64 * 1024);
    expect(result.text).toMatch(/continue with start_line: \d+/);
  });

  it('searches the whole file without keeping it, and hides the key', async () => {
    const found = await run('search', { query: 'needle-in-the-middle', dir: '/download.log' });
    expect(found.structured.matches).toEqual([
      expect.objectContaining({ line: 20000, text: lineFor(20000) }),
    ]);
    expect(found.text).toMatch(/all 40000 lines/);

    const key = await run('search', { query: 'secretkeymaterial', dir: '/download.log' });
    expect(key.structured.matches).toEqual([]);
  });

  it('still answers everything else afterwards', async () => {
    // More abandoned transfers than an FTP pool has connections.
    for (let i = 0; i < 6; i += 1) {
      await run('read', { path: '/download.log', start_line: 1, end_line: 2 });
    }

    const small = await run('read', { path: '/small.txt' });
    expect(small.structured.content).toBe('small\n');
    expect((await fileSystem.list('/')).map((e: any) => e.name)).toContain('download.log');
  });
}

describe('a large file over SFTP', () => {
  let server: RunningServer;

  afterAll(async () => {
    if (server) {
      await server.close();
    }
  });

  behavesLikeALargeFileReader(async () => {
    server = await startSftpServer(root);
    const fileSystem = new SFTPFileSystem(upath, {
      clientOption: {
        host: '127.0.0.1',
        port: server.port,
        username: 'tester',
        password: 'anything',
        connectTimeout: 10000,
        debug: () => undefined,
      } as any,
      operationTimeout: 5000,
    } as any);
    await fileSystem.connect((fileSystem as any).client._option, {
      askForPasswd: async () => undefined,
    });
    return fileSystem;
  });
});

describe('a large file over FTP', () => {
  let server: RunningFtpServer;

  afterAll(async () => {
    if (server) {
      await server.close();
    }
  });

  behavesLikeALargeFileReader(async () => {
    server = await startFtpServer(root);
    const fileSystem = new FTPFileSystem(upath, {
      clientOption: {
        host: '127.0.0.1',
        port: server.port,
        username: 'tester',
        password: 'anything',
        connectTimeout: 5000,
        debug: () => undefined,
      },
      operationTimeout: 5000,
    } as any);
    await fileSystem.connect((fileSystem as any).client._option, {
      askForPasswd: async () => undefined,
    });
    return fileSystem;
  });
});
