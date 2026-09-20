import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import logger from '../logger';
import { getAllFileService } from '../modules/serviceManager';
import app from '../app';
import { createDispatcher, ToolResult } from './protocol';
import { createTools, ToolContext } from './tools';
import { ServiceLike } from './exposure';
import { startServer, StartedServer } from './server';
import { suppressWrite } from '../modules/writeSuppression';
import { pruneOldConnectionFolders } from './cache';
import { adopt as adoptNotes, identityOf } from './notes';
import { DEFAULT_PORT, isAddressInUse, whoHasThePort } from './leader';
import { DEFAULT_WALK } from './search';
import { historyRootFrom } from './localHistory';
import { readBackup } from '../core/overwriteBackup';
import connectionLabel from '../core/connectionLabel';
import { connectionKeyFor, versionsOf } from '../modules/replacedFiles';
import { exposedConnections } from './exposure';
import { stableId } from './identity';
import { localiseCall, PeerRegistry, targetOf, unqualify } from './peers';
import { postJson } from './rpcClient';
import {
  bridgePath,
  clearDiscovery,
  clientSnippet,
  installBridge,
  writeDiscovery,
} from './discovery';

const SERVER_NAME = 'vscode-sftp';
const SERVER_VERSION = '1.0.0';

/**
 * Sets the workflow before any tool is chosen. The common failure is a model
 * reaching for the expensive tool first, so the order is stated up front.
 */
const INSTRUCTIONS =
  'Read-only access to the files on servers configured in the SFTP extension. ' +
  'Call `servers` first: every other tool takes one of its ids, and the ' +
  'listing says what each server is. ' +
  'Prefer `list` over exploring blindly, and scope work to a directory - ' +
  'these are remote servers, so a listing costs a round trip and reading a ' +
  'whole tree is slow. ' +
  'Everything returned is the content on the server, not any local copy. ' +
  'A file exists in three versions - the server\u2019s, the working copy, and ' +
  'the earlier ones the editor saved - and `diff` compares any two of them. ' +
  'Two questions have a cheaper answer than reading: \u201cwhat changed recently\u201d ' +
  'is `tree` with since, not a `search`; and \u201cis what I read still current\u201d ' +
  'is `stat`, which costs one round trip and no file.';

let running: StartedServer | null = null;
let currentToken = '';
let cacheRoot = '';

/**
 * Below what an MCP client will usually wait for an answer.
 *
 * A call that overruns this returns what it has - a partial tree, the matches
 * found so far, and where to carry on from. A call that overruns the client
 * returns nothing at all, and the agent cannot tell that apart from a server
 * with nothing to say.
 */
const DEFAULT_CALL_TIMEOUT = 45000;
/** Set while another window holds the port, so this one can take over later. */
let standbyTimer: NodeJS.Timer | null = null;
/** Set while this window is a follower, keeping its registration alive. */
let registerTimer: NodeJS.Timer | null = null;

/** Distinguishes this window's connection ids from another window's. */
const windowId = `w${process.pid}`;
const peers = new PeerRegistry();
const REGISTER_INTERVAL = 30 * 1000;

const STANDBY_INTERVAL = 30 * 1000;

/** A per-connection `mcp` key, when it has one. */
function readMcp(service: any, key: string): any {
  try {
    const config = service.getConfig();
    return config && config.mcp ? config.mcp[key] : undefined;
  } catch (error) {
    return undefined;
  }
}

function settings() {
  return vscode.workspace.getConfiguration('sftp');
}

function toolContext(): ToolContext {
  return {
    services: () => (getAllFileService() as unknown) as ServiceLike[],
    exposure: () => ({
      exposedByDefault: settings().get<boolean>('mcp.exposed', true),
      profile: app.state.profile,
    }),
    async remoteFs(service: any) {
      const config = service.getConfig();
      return (await service.getRemoteFileSystem(config)) as any;
    },
    cacheOption: (service: any) => ({
      cacheRoot: path.join(cacheRoot, 'mcp-cache'),
      materialize: readMcp(service, 'materialize') !== false,
    }),
    deniedFiles: () => settings().get<string[]>('mcp.deniedFiles', []),
    redaction: () => ({
      assignments: settings().get<boolean>('mcp.redactAssignments', true),
    }),
    maxFileBytes: () => settings().get<number>('mcp.maxFileBytes', 0),
    callTimeout: () => settings().get<number>('mcp.callTimeout', DEFAULT_CALL_TIMEOUT),
    historyRoot: () =>
      settings().get<boolean>('mcp.exposeHistory', true) &&
      vscode.workspace.getConfiguration('workbench').get<boolean>('localHistory.enabled', true)
        ? historyRootFrom(cacheRoot)
        : undefined,
    uriFor: (localPath: string) => vscode.Uri.file(localPath).toString(),
    replacedVersions: async (service: any, localPath: string) => {
      const kept = await versionsOf(connectionKeyFor(service.getConfig()), localPath);
      return kept.map(backup => ({
        id: backup.id,
        timestamp: backup.timestamp,
        read: () => readBackup(backup),
      }));
    },
    walkOption: (service: any) => ({
      ...DEFAULT_WALK,
      maxDepth: settings().get<number>('mcp.maxDepth', DEFAULT_WALK.maxDepth),
      maxFiles: settings().get<number>('mcp.maxFiles', DEFAULT_WALK.maxFiles),
      excludeFolders:
        readMcp(service, 'excludeFolders') ||
        settings().get<string[]>('mcp.excludeFolders', []),
    }),
    // The watcher cannot tell our write from the user's, and would upload it
    // straight back.
    onWorkspaceWrite: suppressWrite,
  };
}

/** The connection an id refers to, for the log rather than for the answer. */
function calledOn(id: any): string | undefined {
  if (typeof id !== 'string' || id === '') {
    return undefined;
  }

  const service = ((getAllFileService() as unknown) as ServiceLike[]).find(
    one => stableId(one) === id
  );

  return service ? connectionLabel(service.getConfig() as any) : undefined;
}

function auditCall(name: string, args: any, result: ToolResult | null, error?: Error) {
  const server = args && args.server ? ` server=${args.server}` : '';
  const target = args && args.path ? ` path=${args.path}` : '';
  const outcome = error ? `failed: ${error.message}` : result && result.isError ? 'refused' : 'ok';

  // When this reaches production servers, "what did the agent actually read?"
  // needs an answer.
  logger
    .for(calledOn(args && args.server))
    .info(`[mcp] ${name}${server}${target} -> ${outcome}`);
}

export async function startMcpServer(): Promise<void> {
  if (running) {
    return;
  }

  const dispatcher = createDispatcher(
    { name: SERVER_NAME, version: SERVER_VERSION, instructions: INSTRUCTIONS },
    () => createTools(toolContext(), () => peers.connections()),
    {
      onCall: auditCall,
      peer: handlePeerMethod,
      forward: forwardToOwner,
      callTimeout: () => settings().get<number>('mcp.callTimeout', DEFAULT_CALL_TIMEOUT),
    }
  );

  currentToken = crypto.randomBytes(24).toString('hex');
  const wanted = settings().get<number>('mcp.port', DEFAULT_PORT) || DEFAULT_PORT;

  try {
    running = await startServer({
      token: currentToken,
      port: wanted,
      dispatcher,
      onError: error => logger.error(error, 'mcp server'),
    });
  } catch (error) {
    if (!isAddressInUse(error)) {
      logger.error(error, 'Could not start the MCP server');
      running = null;
      return;
    }

    const verdict = await whoHasThePort(wanted);
    if (verdict.heldByPeer) {
      // Another window is the leader. Stand by rather than starting a second
      // server the clients would not find.
      logger.info(
        `[mcp] another window is serving on ${wanted}` +
          (verdict.peer && verdict.peer.workspace ? ` (${verdict.peer.workspace})` : '') +
          '. Registering this window with it.'
      );
      running = null;
      await registerWithLeader();
      scheduleStandby();
      scheduleRegistration();
      return;
    }

    // Something that is not us has the port; move rather than never serving.
    logger.warn(
      `[mcp] port ${wanted} is taken by another program; using a free one instead.`
    );
    try {
      running = await startServer({
        token: currentToken,
        port: 0,
        dispatcher,
        onError: err => logger.error(err, 'mcp server'),
      });
    } catch (err) {
      logger.error(err, 'Could not start the MCP server');
      running = null;
      return;
    }
  }

  clearStandby();
  clearRegistration();

  try {
    await installBridge();
    await writeDiscovery({
      port: running.port,
      token: currentToken,
      workspace: firstWorkspaceName(),
      pid: process.pid,
    });
  } catch (error) {
    logger.error(error, 'Could not publish the MCP connection details');
  }

  logger.info(
    `[mcp] listening on 127.0.0.1:${running.port}. ` +
      `Run "SFTP: Show MCP Connection Details" to connect a client.`
  );
}

/**
 * Windows tell the leader what they have, and keep telling it, so a leader that
 * took over mid-session learns about them without anyone restarting.
 */
async function handlePeerMethod(method: string, params: any): Promise<any> {
  if (method === 'peer/register') {
    if (!params || typeof params.windowId !== 'string' || typeof params.url !== 'string') {
      throw new Error('A windowId and url are required.');
    }

    peers.register({
      windowId: params.windowId,
      url: params.url,
      token: String(params.token || ''),
      connections: Array.isArray(params.connections) ? params.connections : [],
      workspace: params.workspace,
    });
    return { ok: true };
  }

  if (method === 'peer/unregister') {
    peers.forget(String((params || {}).windowId));
    return { ok: true };
  }

  throw new Error(`Unknown peer method: ${method}`);
}

/**
 * A call naming another window's connection is answered by that window, with
 * the id rewritten to the one it knows itself by.
 */
async function forwardToOwner(message: any): Promise<any> {
  const target = targetOf(message);
  if (!target || !unqualify(target)) {
    return undefined;
  }

  const owner = peers.ownerOf(target);
  if (!owner) {
    return undefined;
  }

  try {
    return await postJson(owner.url, owner.token, localiseCall(message, target));
  } catch (error) {
    logger.warn(`[mcp] ${owner.windowId} did not answer: ${error.message}`);
    peers.forget(owner.windowId);

    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        // The same words as an id that never existed: a window that has gone
        // should not be distinguishable from one that was never there.
        content: [{ type: 'text', text: 'Unknown server.' }],
        isError: true,
      },
    };
  }
}

/** Open an endpoint of our own and tell the leader what this window has. */
async function registerWithLeader(): Promise<void> {
  const wanted = settings().get<number>('mcp.port', DEFAULT_PORT) || DEFAULT_PORT;
  const verdict = await whoHasThePort(wanted);
  if (!verdict.heldByPeer || !verdict.peer) {
    return;
  }

  if (!running) {
    try {
      running = await startServer({
        token: currentToken,
        port: 0,
        dispatcher: createDispatcher(
          { name: SERVER_NAME, version: SERVER_VERSION, instructions: INSTRUCTIONS },
          () => createTools(toolContext()),
          { onCall: auditCall }
        ),
        onError: error => logger.error(error, 'mcp follower'),
      });
    } catch (error) {
      logger.error(error, 'Could not open a follower endpoint');
      return;
    }
  }

  const context = toolContext();
  try {
    await postJson(`http://127.0.0.1:${verdict.peer.port}/`, verdict.peer.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'peer/register',
      params: {
        windowId,
        url: `http://127.0.0.1:${running.port}/`,
        token: currentToken,
        workspace: firstWorkspaceName(),
        connections: exposedConnections(context.services(), context.exposure()),
      },
    });
  } catch (error) {
    logger.warn(`[mcp] could not register with the leading window: ${error.message}`);
  }
}

function scheduleRegistration() {
  clearRegistration();
  registerTimer = setInterval(registerWithLeader, REGISTER_INTERVAL);
}

function clearRegistration() {
  if (registerTimer) {
    clearInterval(registerTimer);
    registerTimer = null;
  }
}

function scheduleStandby() {
  clearStandby();
  standbyTimer = setInterval(() => {
    if (!running && settings().get<boolean>('mcp.enabled', false)) {
      startMcpServer();
    }
  }, STANDBY_INTERVAL);
}

function clearStandby() {
  if (standbyTimer) {
    clearInterval(standbyTimer);
    standbyTimer = null;
  }
}

export async function stopMcpServer(): Promise<void> {
  clearStandby();
  clearRegistration();

  if (!running) {
    return;
  }

  const server = running;
  running = null;
  currentToken = '';

  await server.close();
  await clearDiscovery();
  logger.info('[mcp] stopped.');
}

export function isRunning(): boolean {
  return running !== null;
}

export function connectionDetails(): string {
  if (!running) {
    return (
      'The MCP server is not running. Set "sftp.mcp.enabled" to true in your ' +
      'settings, then run this command again.'
    );
  }

  const exposed = createTools(toolContext());

  return [
    `Listening on 127.0.0.1:${running.port}`,
    '',
    'For a client that speaks stdio (Claude Desktop and most others), add this',
    'to its MCP configuration. It carries no token and no port, so it never',
    'needs updating:',
    '',
    clientSnippet(),
    '',
    `The bridge lives at ${bridgePath()} and is refreshed on every start.`,
    '',
    `Tools: ${exposed.map(tool => tool.name).join(', ')}`,
  ].join('\n');
}

function firstWorkspaceName(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

/**
 * Started and stopped by the setting, so turning it off releases the port and
 * takes the connection details away rather than leaving a stale file behind.
 */
/**
 * Notes written under an id a connection no longer has - because it was
 * renamed, or because the way an id is derived changed under it - moved to
 * where that connection looks now.
 *
 * At startup rather than on demand, and it adopts nothing for a connection
 * that has not loaded yet: the worst case is that it happens next time.
 */
async function reuniteNotes(): Promise<void> {
  const services = (getAllFileService() as unknown) as ServiceLike[];
  const root = path.join(cacheRoot, 'mcp-cache');
  const everyone = services.map(service => ({
    id: stableId(service),
    identity: identityOf(service.workspace, service.getConfig()),
  }));

  for (const service of services) {
    try {
      const from = await adoptNotes(
        root,
        stableId(service),
        identityOf(service.workspace, service.getConfig()),
        everyone
      );

      if (from) {
        logger
          .for(connectionLabel(service.getConfig() as any))
          .info(`[mcp] took back the notes filed under ${from}.`);
      }
    } catch (error) {
      // One connection's notes are not worth failing the others over.
    }
  }
}

export function initMcp(context: vscode.ExtensionContext) {
  cacheRoot = context.globalStoragePath;

  // Once, at startup: notes filed under an id this connection no longer has,
  // and folders left by the numbering this all replaced. See `identity.ts`.
  reuniteNotes().catch(error =>
    logger.debug(`could not look for orphaned notes: ${error.message}`)
  );

  pruneOldConnectionFolders(
    path.join(cacheRoot, 'mcp-cache'),
    ((getAllFileService() as unknown) as ServiceLike[]).map(stableId)
  )
    .then(removed => {
      if (removed.length > 0) {
        logger.info(
          `[mcp] removed ${removed.length} cache folder` +
            `${removed.length === 1 ? '' : 's'} from the old connection numbering.`
        );
      }
    })
    .catch(error => logger.debug(`could not sweep the old cache: ${error.message}`));

  const sync = () => {
    if (settings().get<boolean>('mcp.enabled', false)) {
      startMcpServer();
    } else {
      stopMcpServer();
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('sftp.mcp')) {
        sync();
      }
    })
  );

  context.subscriptions.push({ dispose: () => stopMcpServer() });

  sync();
}
