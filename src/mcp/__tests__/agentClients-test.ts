import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
  AGENT_CLIENTS,
  AgentClient,
  agentsWithout,
  findExecutable,
  isRegistered,
  register,
} from '../agentClients';

const claude = AGENT_CLIENTS.find(one => one.command === 'claude')!;
const codex = AGENT_CLIENTS.find(one => one.command === 'codex')!;

describe('finding an agent', () => {
  it('takes the one on PATH first', () => {
    const found = findExecutable(
      'claude',
      { PATH: ['/a', '/b'].join(path.delimiter) },
      file => file === '/b/claude' || file === '/home/me/.local/bin/claude',
      '/home/me'
    );
    expect(found).toBe('/b/claude');
  });

  // Started from the Dock, the editor's PATH lacks where the installers put them.
  it('finds it where its installer puts it when PATH does not have it', () => {
    const found = findExecutable(
      'codex',
      { PATH: '/usr/bin' },
      file => file === '/home/me/.local/bin/codex',
      '/home/me'
    );
    expect(found).toBe('/home/me/.local/bin/codex');
  });

  it('is nothing when it is not installed', () => {
    expect(findExecutable('claude', { PATH: '/usr/bin' }, () => false, '/home/me')).toBeUndefined();
  });
});

describe('what each agent is asked', () => {
  it('Claude Code registers it for every project', () => {
    expect(claude.addArguments('/b/mcp-bridge.js', '/n/node')).toEqual(
      ['mcp', 'add', '--scope', 'user', 'sftp', '--', '/n/node', '/b/mcp-bridge.js']
    );
  });

  it('Codex has one configuration and no scope to name', () => {
    expect(codex.addArguments('/b/mcp-bridge.js', '/n/node')).toEqual(
      ['mcp', 'add', 'sftp', '--', '/n/node', '/b/mcp-bridge.js']
    );
  });
});

/**
 * Against a stand-in that answers like the real CLIs: `mcp get` fails until
 * `mcp add` has run, and every call is written down.
 */
describe('talking to an agent', () => {
  let dir: string;

  function standIn(name: string): string {
    const cli = path.join(dir, name);
    fs.writeFileSync(
      cli,
      [
        '#!/bin/sh',
        `echo "$@" >> "${dir}/${name}.calls"`,
        'if [ "$1 $2" = "mcp get" ]; then',
        `  [ -f "${dir}/${name}.added" ] && exit 0`,
        "  echo \"No MCP server named 'sftp' found.\" >&2; exit 1",
        'fi',
        `if [ "$1 $2" = "mcp add" ]; then touch "${dir}/${name}.added"; exit 0; fi`,
        'exit 2',
      ].join('\n'),
      { mode: 0o755 }
    );
    return cli;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
  });

  afterEach(() => fse.removeSync(dir));

  it('reads not registered, registers, then reads registered', async () => {
    const cli = standIn('claude');
    expect(await isRegistered(claude, cli)).toBe(false);

    expect((await register(claude, cli, '/b/mcp-bridge.js', '/n/node')).ok).toBe(true);

    expect(await isRegistered(claude, cli)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'claude.calls'), 'utf8')).toContain(
      'mcp add --scope user sftp -- /n/node /b/mcp-bridge.js'
    );
  });

  // Not everybody has Claude: an agent that is not installed is skipped, and
  // one that already has the tools is left alone.
  it('lists only the installed agents that lack the tools', async () => {
    const codexCli = standIn('codex');
    standIn('claude');
    fs.writeFileSync(path.join(dir, 'claude.added'), '');

    const missing = await agentsWithout(AGENT_CLIENTS, name =>
      name === 'gemini' ? undefined : path.join(dir, name)
    );

    expect(missing.map(one => one.client.label)).toEqual(['Codex']);
    expect(missing[0].cli).toBe(codexCli);
  });

  it('is nothing to do when no agent is installed', async () => {
    expect(await agentsWithout(AGENT_CLIENTS, () => undefined)).toEqual([]);
  });

  it('a client list can be any agents', async () => {
    const other: AgentClient = {
      command: 'other',
      label: 'Other',
      getArguments: ['mcp', 'get', 'sftp'],
      addArguments: (b, n) => ['mcp', 'add', 'sftp', '--', n, b],
    };
    standIn('other');
    expect((await agentsWithout([other], name => path.join(dir, name))).length).toBe(1);
  });
});
