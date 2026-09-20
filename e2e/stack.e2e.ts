import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import upath from '../src/core/upath';
import SFTPFileSystem from '../src/core/fs/sftpFileSystem';
import { createTools, ToolContext } from '../src/mcp/tools';
import { createDispatcher } from '../src/mcp/protocol';
import { startServer, StartedServer } from '../src/mcp/server';
import { startSftpServer, RunningServer } from './sftpServer';
import { validate } from './schemaCheck';

/**
 * The whole stack, end to end, against a real server over a real socket.
 *
 * Everything below `RemoteLike` is faked in the unit tests, which is most of
 * what could actually be wrong with talking to a server: the ssh2 client, the
 * pipelined transfers, the streams, and what happens when a server stops
 * answering. This runs the real file system implementation against a real SFTP
 * server, through the real MCP dispatcher and HTTP server, and drives it as a
 * client would.
 */

jest.setTimeout(60000);

const SERVER_FILES: { [name: string]: string } = {
  'index.php': ['<?php', `require 'app/boot.php';`, 'run();'].join('\n'),
  'config.php': [
    '<?php',
    `define('DB_PASSWORD', 'Xk7mQ2vL9pR');`,
    `define('DB_NAME', 'shop');`,
  ].join('\n'),
  'README.md': '# The shop\n\nA test fixture.\n',
  '.env': 'SECRET=never served\n',
  'app/boot.php': ['<?php', 'function run() { echo "hello"; }'].join('\n'),
  'app/big.log': 'x'.repeat(300 * 1024),
};

let remote: RunningServer;
let serverRoot: string;
let workspace: string;
let cacheRoot: string;
let fileSystem: SFTPFileSystem;
let mcp: StartedServer;
const TOKEN = 'e2e-token';

function makeTree(root: string, files: { [name: string]: string }) {
  Object.keys(files).forEach(name => {
    const full = path.join(root, name);
    fse.ensureDirSync(path.dirname(full));
    fs.writeFileSync(full, files[name]);
  });
}

/** A JSON-RPC call over the real HTTP endpoint, as a client makes it. */
function call(method: string, params?: any): Promise<any> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: mcp.port,
        method: 'POST',
        path: '/',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${TOKEN}`,
        },
      },
      response => {
        let text = '';
        response.on('data', chunk => (text += chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(new Error(`${response.statusCode}: ${text}`));
          }
        });
      }
    );
    request.on('error', reject);
    request.end(body);
  });
}

const tool = async (name: string, args: any) => {
  const answer = await call('tools/call', { name, arguments: args });
  if (answer.error) {
    throw new Error(answer.error.message);
  }
  return answer.result;
};

const textOf = (result: any) => result.content[0].text as string;

beforeAll(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-e2e-'));
  serverRoot = path.join(base, 'server');
  workspace = path.join(base, 'workspace');
  cacheRoot = path.join(base, 'cache');
  fs.mkdirSync(serverRoot);
  fs.mkdirSync(workspace);
  makeTree(serverRoot, SERVER_FILES);

  remote = await startSftpServer(serverRoot);

  // The real client, over a real socket, speaking real SFTP.
  fileSystem = new SFTPFileSystem(upath, {
    clientOption: {
      host: '127.0.0.1',
      port: remote.port,
      username: 'tester',
      password: 'anything',
      connectTimeout: 10000,
      debug: () => undefined,
    } as any,
    operationTimeout: 3000,
  } as any);

  await fileSystem.connect(
    (fileSystem as any).client._option,
    { askForPasswd: async () => undefined }
  );

  const service: any = {
    id: 1,
    name: 'Fixture',
    workspace,
    baseDir: workspace,
    getConfig: () => ({
      name: 'Fixture',
      protocol: 'sftp',
      host: '127.0.0.1',
      port: remote.port,
      remotePath: '/',
    }),
  };

  const scoped: any = {
    id: 2,
    name: 'Scoped',
    workspace,
    baseDir: path.join(workspace, 'app'),
    getConfig: () => ({
      name: 'Scoped',
      protocol: 'sftp',
      host: '127.0.0.1',
      port: remote.port,
      remotePath: '/app',
    }),
  };

  const context: ToolContext = {
    services: () => [service, scoped],
    exposure: () => ({ exposedByDefault: true }),
    remoteFs: async () => fileSystem as any,
    cacheOption: () => ({ cacheRoot }),
    callTimeout: () => 30000,
  } as any;

  mcp = await startServer({
    token: TOKEN,
    port: 0,
    dispatcher: createDispatcher(
      { name: 'vscode-sftp', version: 'e2e', instructions: '' },
      () => createTools(context)
    ),
    onError: () => undefined,
  });
});

afterAll(async () => {
  if (mcp) {
    await mcp.close();
  }
  if (fileSystem) {
    fileSystem.end();
  }
  if (remote) {
    await remote.close();
  }
});

describe('the whole stack against a real server', () => {
  it('completes the handshake and lists its tools', async () => {
    const initialised = await call('initialize', { protocolVersion: '2024-11-05' });
    expect(initialised.result.serverInfo.name).toBe('vscode-sftp');

    const tools = await call('tools/list');
    expect(tools.result.tools.map((t: any) => t.name)).toContain('read');
  });

  it('gives an id that survives the editor renumbering its connections', async () => {
    // What an agent actually does: read the listing, then use the id from it.
    // The editor numbers connections as it loads them, so the number a client
    // wrote down this morning belongs to another server this afternoon.
    const listed = await tool('servers', {});
    const fixture = listed.structuredContent.servers.find(
      (one: any) => one.name === 'Fixture'
    );

    expect(fixture.id).not.toBe('1');

    const byId = await tool('list', { server: fixture.id, path: '/' });
    expect(byId.structuredContent.entries.map((e: any) => e.name)).toContain(
      'index.php'
    );

    // And the number it replaced addresses nothing at all.
    const byNumber = await tool('list', { server: '1', path: '/' });
    expect(byNumber.isError).toBe(true);
  });

  it('lists a real directory', async () => {
    const result = await tool('list', { server: 'Fixture', path: '/' });
    const names = result.structuredContent.entries.map((e: any) => e.name);

    expect(names).toContain('index.php');
    expect(names).toContain('app');
  });

  it('fetches a file byte for byte and leaves it in the workspace', async () => {
    const result = await tool('read', { server: 'Fixture', path: '/index.php' });

    expect(textOf(result)).toContain(`require 'app/boot.php';`);
    // The transfer went over a socket and landed on disk unchanged.
    expect(fs.readFileSync(path.join(workspace, 'index.php'), 'utf8')).toBe(
      SERVER_FILES['index.php']
    );
  });

  it('redacts a credential on the way out but not on disk', async () => {
    const result = await tool('read', {
      server: 'Fixture',
      path: '/config.php',
      start_line: 1,
    });

    expect(textOf(result)).not.toContain('Xk7mQ2vL9pR');
    expect(fs.readFileSync(path.join(workspace, 'config.php'), 'utf8')).toContain(
      'Xk7mQ2vL9pR'
    );
  });

  it('never serves a denied file', async () => {
    const result = await tool('read', { server: 'Fixture', path: '/.env' });

    expect(result.isError).toBe(true);
    expect(fs.existsSync(path.join(workspace, '.env'))).toBe(false);
  });

  it('searches the real tree and finds a line', async () => {
    const result = await tool('search', { server: 'Fixture', query: 'echo' });

    expect(textOf(result)).toContain('boot.php');
  });

  it('walks the tree and reports what it found', async () => {
    const result = await tool('tree', { server: 'Fixture' });

    expect(result.structuredContent.files.map((f: any) => f.path)).toContain(
      '/app/boot.php'
    );
  });

  it('refuses a path outside the connection', async () => {
    // Connection 2 exposes /app only. Connection 1 is rooted at `/`, which
    // exposes everything below it on purpose.
    const escape = await tool('stat', {
      server: 'Scoped',
      path: '/app/../index.php',
    });
    expect(escape.isError).toBe(true);
    expect(textOf(escape)).toContain('outside /app');

    const inside = await tool('stat', { server: 'Scoped', path: '/app/boot.php' });
    expect(inside.isError).toBe(false);
  });

  it('diffs the server against the working copy', async () => {
    fs.writeFileSync(
      path.join(workspace, 'README.md'),
      '# The shop\n\nEdited here.\n'
    );

    const result = await tool('diff', { server: 'Fixture', path: '/README.md' });

    expect(textOf(result)).toContain('+Edited here.');
    expect(textOf(result)).toContain('-A test fixture.');
  });
});

describe('when the server stops answering', () => {
  afterEach(() => remote.misbehave({}));

  it('gives up on a command that never comes back', async () => {
    remote.misbehave({ stallStatOf: ['index.php'] });

    const started = Date.now();
    const result = await tool('stat', { server: 'Fixture', path: '/index.php' });
    const waited = Date.now() - started;

    // The operation timeout is 3s here; without it this call never returns.
    expect(result.isError).toBe(true);
    // Not \u201cnot on the server\u201d: the file is there, the server went quiet, and
    // reporting an absence would send a reader off to create what exists.
    expect(textOf(result)).toContain('did not answer');
    expect(textOf(result)).not.toContain('is not on the server');
    expect(waited).toBeLessThan(15000);
  });

  it('gives up on a transfer that goes quiet mid-file', async () => {
    // A file nothing has fetched yet: the earlier search materialised
    // everything it walked, and a file already on disk and unchanged is
    // served from there without the server being asked for a byte.
    fs.writeFileSync(path.join(serverRoot, 'app', 'fresh.log'), 'y'.repeat(300 * 1024));
    remote.misbehave({ stallReadsOf: ['fresh.log'], bytesBeforeStall: 32768 });

    const started = Date.now();
    const result = await tool('read', {
      server: 'Fixture',
      path: '/app/fresh.log',
      start_line: 1,
    });
    const waited = Date.now() - started;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/stopped making progress|did not answer/);
    expect(waited).toBeLessThan(30000);
  });

  it('still works afterwards', async () => {
    // Whatever the stall did to the connection, the next call recovers.
    const result = await tool('list', { server: 'Fixture', path: '/' });

    expect(result.isError).toBe(false);
  });
});

/**
 * What a tool declares is what it returns.
 *
 * A tool that declares an output schema is telling the client to read the
 * structured half of the reply and ignore the text - which is what a client
 * does. `read` declared one and put the file only in the text, so a real
 * client got the path, the state and the timestamps of a file whose contents
 * it never saw, and every test passed because every test read the text.
 *
 * So each tool is called for real, and the reply is checked against its own
 * promise: the schema it published, and the one thing it exists to return.
 */

describe('what every tool promises', () => {
  /**
   * One real call per tool, and what the answer has to contain to be worth
   * making. A tool added without a line here fails the last test in this
   * block, which is the point of it.
   */
  const CALLS: {
    [name: string]: { args: any; substance?(structured: any, text: string): void };
  } = {
    servers: { args: {} },
    list: {
      args: { server: 'Fixture', path: '/' },
      substance: structured =>
        expect(structured.entries.map((e: any) => e.name)).toContain('index.php'),
    },
    stat: {
      args: { server: 'Fixture', path: '/index.php' },
      substance: structured => {
        expect(structured.size).toBe(SERVER_FILES['index.php'].length);
        expect(structured.mtime).toBeGreaterThan(0);
      },
    },
    read: {
      args: { server: 'Fixture', path: '/index.php' },
      // The one that shipped broken: everything about the file except the file.
      substance: structured =>
        expect(structured.content).toContain(`require 'app/boot.php';`),
    },
    'local-copy': { args: { server: 'Fixture', path: '/index.php' } },
    search: {
      args: { server: 'Fixture', query: 'echo' },
      substance: structured =>
        expect(structured.matches.map((m: any) => m.path).join()).toContain('boot.php'),
    },
    tree: {
      args: { server: 'Fixture' },
      substance: structured =>
        expect(structured.files.map((f: any) => f.path)).toContain('/app/boot.php'),
    },
    note: { args: { server: 'Fixture', path: '/index.php', summary: 'the front controller' } },
    overview: { args: { server: 'Fixture' } },
    history: { args: { server: 'Fixture', path: '/index.php' } },
    diff: { args: { server: 'Fixture', path: '/README.md' } },
    forget: { args: { server: 'Fixture', path: '/index.php' } },
  };

  let declared: any[];

  beforeAll(async () => {
    declared = (await call('tools/list')).result.tools;
  });

  it('answers every one of them against a real server', async () => {
    const failures: string[] = [];

    for (const definition of declared) {
      const planned = CALLS[definition.name];
      if (!planned) {
        continue; // Reported by the last test in this block.
      }

      const result = await tool(definition.name, planned.args);
      const text = result.content && result.content[0] ? result.content[0].text : '';

      if (result.isError) {
        failures.push(`${definition.name}: ${text}`);
        continue;
      }

      if (definition.outputSchema) {
        // Declaring a schema is a promise that the answer is in the structured
        // half, so there has to be one.
        if (!result.structuredContent) {
          failures.push(`${definition.name}: declares an output schema and returned none`);
          continue;
        }
        failures.push(
          ...validate(result.structuredContent, definition.outputSchema, definition.name)
        );
      }

      if (planned.substance) {
        planned.substance(result.structuredContent || {}, text);
      }
    }

    expect(failures).toEqual([]);
  });

  it('has a call here for every tool it offers', () => {
    expect(declared.map((one: any) => one.name).sort()).toEqual(
      Object.keys(CALLS).sort()
    );
  });
});
