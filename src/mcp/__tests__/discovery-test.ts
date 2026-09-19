import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  bridgePath,
  clearDiscovery,
  clientSnippet,
  discoveryPath,
  homeDir,
  installBridge,
  writeDiscovery,
} from '../discovery';
import { createDispatcher, ToolDefinition } from '../protocol';
import { startServer, StartedServer } from '../server';

const SANDBOX = path.join(os.tmpdir(), 'vscode-sftp-mcp-test');

describe('discovery and the stdio bridge', () => {
  let server: StartedServer;
  const token = 'tok_end_to_end_test';

  const tools = (): ToolDefinition[] => [
    {
      name: 'sftp_servers',
      description: 'servers',
      inputSchema: { type: 'object' },
      run: async () => ({ text: 'one server', structured: { servers: [{ id: '1' }] } }),
    },
  ];

  beforeAll(async () => {
    process.env.VSCODE_SFTP_HOME = SANDBOX;
    await fse.remove(SANDBOX);

    server = await startServer({
      token,
      dispatcher: createDispatcher(
        { name: 'vscode-sftp', version: '1.0.0', instructions: 'Call sftp_servers first.' },
        tools
      ),
    });

    await installBridge();
    await writeDiscovery({ port: server.port, token, pid: process.pid });
  });

  afterAll(async () => {
    await server.close();
    await fse.remove(SANDBOX);
    delete process.env.VSCODE_SFTP_HOME;
  });

  it('writes the details where the bridge looks for them', async () => {
    expect(homeDir()).toBe(SANDBOX);

    const written = JSON.parse(await fse.readFile(discoveryPath(), 'utf8'));
    expect(written.port).toBe(server.port);
    expect(written.token).toBe(token);
  });

  it('keeps the details readable only by their owner', async () => {
    const stat = await fse.stat(discoveryPath());
    // The token is in this file; nobody else on the machine needs it.
    const permissions = (stat.mode % 0o1000).toString(8);
    expect(permissions).toBe('600');
  });

  it('offers a snippet with nothing in it that can go stale', () => {
    const snippet = JSON.parse(clientSnippet());

    expect(snippet.mcpServers.sftp.args).toEqual([bridgePath()]);
    // No token, no port: the two things that change between runs.
    expect(clientSnippet()).not.toContain(token);
    expect(clientSnippet()).not.toContain(String(server.port));
  });

  /** Drive the real bridge the way a client does: newline-delimited JSON on stdio. */
  function throughBridge(lines: string[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bridgePath()], {
        env: { ...process.env, VSCODE_SFTP_HOME: SANDBOX },
      });

      let out = '';
      let err = '';
      child.stdout.on('data', chunk => (out += chunk));
      child.stderr.on('data', chunk => (err += chunk));
      child.on('error', reject);
      child.on('close', () => {
        if (err) {
          reject(new Error(err));
          return;
        }
        resolve(out.split('\n').filter(line => line.trim() !== ''));
      });

      child.stdin.end(lines.map(line => line + '\n').join(''));
    });
  }

  it('carries a whole handshake end to end', async () => {
    const replies = await throughBridge([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'sftp_servers', arguments: {} },
      }),
    ]);

    // Three requests, one notification: three replies, in order.
    expect(replies).toHaveLength(3);

    const initialize = JSON.parse(replies[0]);
    expect(initialize.id).toBe(1);
    expect(initialize.result.serverInfo.name).toBe('vscode-sftp');
    expect(initialize.result.instructions).toContain('sftp_servers');

    const list = JSON.parse(replies[1]);
    expect(list.result.tools[0].name).toBe('sftp_servers');

    const call = JSON.parse(replies[2]);
    expect(call.result.content[0].text).toBe('one server');
    expect(call.result.structuredContent).toEqual({ servers: [{ id: '1' }] });
  });

  it('writes one line per reply, so a client can frame them', async () => {
    const replies = await throughBridge([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    ]);

    expect(replies).toHaveLength(2);
    replies.forEach(line => expect(() => JSON.parse(line)).not.toThrow());
  });

  it('says something useful when the server is not there', async () => {
    await clearDiscovery();

    await expect(throughBridge([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    ])).rejects.toThrow(/Open VS Code with the SFTP extension/);

    // put it back for any later test
    await writeDiscovery({ port: server.port, token, pid: process.pid });
  });
});
