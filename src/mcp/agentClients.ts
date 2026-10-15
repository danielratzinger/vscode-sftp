import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

/**
 * Making the tools reachable from the agents installed on this machine,
 * whichever they are, without anybody copying a snippet.
 *
 * Each keeps its MCP servers in its own configuration, and each has its own
 * supported way to change it - `claude mcp add`, `codex mcp add`. That is
 * what is run, rather than their files being edited from here: the files are
 * theirs, and they write them while they run. An agent that is not installed
 * is skipped; one whose CLI cannot add a server without asking its own
 * questions is left to the snippet in `Show MCP Connection Details`.
 *
 * Nothing here decides to do it. Whether to is asked of the person, once.
 */

/** The name the server is registered under - the one the tools appear as. */
export const SERVER_NAME = 'sftp';

export interface AgentClient {
  /** The executable. */
  command: string;
  /** What a person calls it. */
  label: string;
  /** Arguments that succeed exactly when a server by our name is registered. */
  getArguments: string[];
  /** Arguments that register the bridge for every project. */
  addArguments(bridge: string, node: string): string[];
}

export const AGENT_CLIENTS: AgentClient[] = [
  {
    command: 'claude',
    label: 'Claude Code',
    getArguments: ['mcp', 'get', SERVER_NAME],
    addArguments: (bridge, node) => ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', node, bridge],
  },
  {
    command: 'codex',
    label: 'Codex',
    getArguments: ['mcp', 'get', SERVER_NAME],
    // Codex has one configuration, `~/.codex/config.toml`; there is no scope to name.
    addArguments: (bridge, node) => ['mcp', 'add', SERVER_NAME, '--', node, bridge],
  },
];

/**
 * Where an executable is, looked for the way a shell would and then in the
 * places installers put one. The editor is often started from the Dock, not a
 * shell, and then its PATH does not have `~/.local/bin` - which is where
 * Claude Code's and Codex's own installers put them.
 */
export function findExecutable(
  name: string,
  env: { PATH?: string } = process.env,
  exists: (file: string) => boolean = isExecutable,
  home: string = os.homedir()
): string | undefined {
  const fromPath = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const usual = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];

  for (const dir of fromPath.concat(usual)) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch (error) {
    return false;
  }
}

function run(cli: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    execFile(cli, args, { timeout: 30000 }, (error, stdout, stderr) =>
      resolve({ ok: !error, output: `${stdout || ''}${stderr || ''}`.trim() })
    );
  });
}

/** Whether the agent already has a server by our name, whatever it points at. */
export async function isRegistered(client: AgentClient, cli: string): Promise<boolean> {
  return (await run(cli, client.getArguments)).ok;
}

export function register(
  client: AgentClient,
  cli: string,
  bridge: string,
  node: string
): Promise<{ ok: boolean; output: string }> {
  return run(cli, client.addArguments(bridge, node));
}

/** The installed agents that do not have the tools yet. */
export async function agentsWithout(
  clients: AgentClient[] = AGENT_CLIENTS,
  find: (name: string) => string | undefined = findExecutable
): Promise<Array<{ client: AgentClient; cli: string }>> {
  const missing: Array<{ client: AgentClient; cli: string }> = [];
  for (const client of clients) {
    const cli = find(client.command);
    if (cli && !(await isRegistered(client, cli))) {
      missing.push({ client, cli });
    }
  }
  return missing;
}
