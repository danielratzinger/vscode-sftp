import * as path from 'path';
import * as vscode from 'vscode';
import logger, { withConnection } from '../logger';
import connectionLabel from '../core/connectionLabel';
import { UResource, FileService } from '../core';
import { uploadFile, removeRemote } from '../fileHandlers';
import { getAllFileService } from './serviceManager';
import { stableId } from '../mcp/identity';
import {
  describeWorktree,
  Worktree,
  worktreeRegistryOf,
  worktreesOf,
} from '../core/worktrees';

/**
 * Deploying from a checkout the editor does not have open.
 *
 * An agent working on a branch gets its own worktree, usually nowhere near the
 * folder in this window. Until now the only way to deploy from one was to
 * start something inside it by hand. This watches it instead - the same
 * upload-on-change the workspace gets, sourced from somewhere else.
 *
 * **One writer.** A connection has one remote path, and three worktrees on
 * three branches writing to it would leave whichever saved last. So a
 * connection syncs from exactly one worktree at a time, chosen deliberately,
 * and while that is not this window the window's own uploads are paused and
 * said to be paused. Nothing here starts on its own: a new worktree is
 * offered, never adopted.
 */

const REMEMBERED = 'sftp.worktreeSync';
const OFFERED = 'sftp.worktreeSyncOffered';

/**
 * How long a file must sit still before it is uploaded.
 *
 * A build step writes a hundred files in a second, and a tool that writes
 * without an atomic rename leaves a half-written one visible in between.
 * Waiting batches the first and avoids the second.
 */
const SETTLE = 3000;

interface Chosen {
  root: string;
  branch?: string;
}

let storage: vscode.Memento | undefined;

/** One per connection currently syncing from somewhere else. */
const watching = new Map<string, vscode.Disposable[]>();

/** Files seen changing, waiting to settle. */
const settling = new Map<string, any>();

const chosenAll = (): { [id: string]: Chosen } =>
  (storage && storage.get(REMEMBERED, {})) || {};

export function activeWorktree(service: FileService): Chosen | undefined {
  return chosenAll()[stableId(service as any)];
}

/**
 * Whether this connection's own window should keep quiet.
 *
 * Only while another checkout owns the connection. A connection syncing from
 * the folder in this window is the ordinary case and pauses nothing.
 */
export function pausedFor(service: FileService): Chosen | undefined {
  const chosen = activeWorktree(service);
  if (!chosen || samePath(chosen.root, service.baseDir)) {
    return undefined;
  }

  return chosen;
}

const said = new Set<string>();

/** Says once per connection per window why a save did not go up. */
export function sayIfPaused(service: FileService): boolean {
  const chosen = pausedFor(service);
  if (!chosen) {
    return false;
  }

  const key = `${stableId(service as any)}|${chosen.root}`;
  if (!said.has(key)) {
    said.add(key);
    logger
      .for(connectionLabel(service.getConfig() as any))
      .info(
        `[worktree] not uploading from this window: the connection is syncing ` +
          `${chosen.branch || chosen.root}. "SFTP: Sync Worktree" changes that.`
      );
  }

  return true;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/** The connection's own ignore rules, asked about a file in another checkout. */
function ignoredInWorktree(
  service: FileService,
  root: string,
  file: string
): boolean {
  const ignore = service.getConfig().ignore;
  if (!ignore) {
    return false;
  }

  // The matcher anchors on the folder this connection manages, so a path from
  // elsewhere has to be asked about as the path it would have there.
  return ignore(path.join(service.baseDir, path.relative(root, file)));
}

function contextFor(service: FileService, root: string, file: string) {
  const config = service.getConfig();

  return {
    fileService: service,
    config,
    target: UResource.from(vscode.Uri.file(file), {
      localBasePath: root,
      remoteBasePath: config.remotePath,
      remoteId: service.id,
      remote: { host: config.host, port: config.port },
    }),
  };
}

async function upload(service: FileService, root: string, file: string) {
  if (ignoredInWorktree(service, root, file)) {
    return;
  }

  await withConnection(connectionLabel(service.getConfig() as any), async () => {
    try {
      await uploadFile(contextFor(service, root, file) as any);
      logger.info(`[worktree] ${path.relative(root, file)}`);
    } catch (error) {
      logger.error(error, `worktree upload ${file}`);
    }
  });
}

async function remove(service: FileService, root: string, file: string) {
  if (ignoredInWorktree(service, root, file)) {
    return;
  }

  await withConnection(connectionLabel(service.getConfig() as any), async () => {
    try {
      await removeRemote(contextFor(service, root, file) as any);
      logger.info(`[worktree] removed ${path.relative(root, file)}`);
    } catch (error) {
      logger.error(error, `worktree delete ${file}`);
    }
  });
}

function afterItSettles(key: string, run: () => void): void {
  const pending = settling.get(key);
  if (pending) {
    clearTimeout(pending);
  }

  settling.set(
    key,
    setTimeout(() => {
      settling.delete(key);
      run();
    }, SETTLE)
  );
}

/** Never worth uploading, whatever the connection's own rules say. */
function isGitPlumbing(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '.git' || relative.indexOf(`.git${path.sep}`) === 0;
}

function watchWorktree(service: FileService, chosen: Chosen): vscode.Disposable[] {
  const config = service.getConfig();
  const root = chosen.root;
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(root), '**/*')
  );

  const changed = (uri: vscode.Uri) => {
    if (isGitPlumbing(root, uri.fsPath)) {
      return;
    }
    afterItSettles(uri.fsPath, () => upload(service, root, uri.fsPath));
  };

  watcher.onDidCreate(changed);
  watcher.onDidChange(changed);
  watcher.onDidDelete(uri => {
    if (isGitPlumbing(root, uri.fsPath)) {
      return;
    }

    const pending = settling.get(uri.fsPath);
    if (pending) {
      clearTimeout(pending);
      settling.delete(uri.fsPath);
    }

    // Deleting on the server follows the same setting as the workspace
    // watcher's: removing files from a deployment is not something to start
    // doing because somebody picked a worktree.
    const watcherConfig = (config as any).watcher;
    if (watcherConfig && watcherConfig.autoDelete) {
      remove(service, root, uri.fsPath);
    }
  });

  logger
    .for(connectionLabel(config as any))
    .info(
      `[worktree] syncing ${chosen.branch || root} from ${root}` +
        (samePath(root, service.baseDir) ? '' : '; this window is paused')
    );

  return [watcher];
}

function stopWatching(id: string): void {
  const held = watching.get(id);
  if (held) {
    held.forEach(one => one.dispose());
    watching.delete(id);
  }
}

async function remember(service: FileService, chosen?: Chosen): Promise<void> {
  if (!storage) {
    return;
  }

  const id = stableId(service as any);
  const all = chosenAll();

  if (chosen) {
    all[id] = chosen;
  } else {
    delete all[id];
  }

  await storage.update(REMEMBERED, all);
  said.delete(`${id}|${chosen ? chosen.root : ''}`);

  stopWatching(id);
  if (chosen) {
    watching.set(id, watchWorktree(service, chosen));
  } else {
    logger
      .for(connectionLabel(service.getConfig() as any))
      .info('[worktree] stopped; this window uploads again.');
  }
}

/** The command: which checkout should this connection deploy from? */
export async function chooseWorktree(service: FileService): Promise<void> {
  const found = await worktreesOf(service.baseDir);
  if (found.length === 0) {
    vscode.window.showInformationMessage(
      `${connectionLabel(service.getConfig() as any)} is not in a git repository.`
    );
    return;
  }

  const active = activeWorktree(service);
  const items = found
    .filter(one => one.exists)
    .map(one => ({
      label: one.branch || one.name,
      description: describeWorktree(one),
      detail:
        active && samePath(active.root, one.root)
          ? 'syncing now'
          : one.isMain
          ? 'the folder this window has open'
          : undefined,
      worktree: one as Worktree | undefined,
    }));

  if (active) {
    items.push({
      label: 'Stop syncing',
      description: 'nothing is uploaded until you save in this window again',
      detail: undefined,
      worktree: undefined,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Deploy to ${connectionLabel(service.getConfig() as any)} from…`,
  });

  if (!picked) {
    return;
  }

  await remember(
    service,
    picked.worktree
      ? { root: picked.worktree.root, branch: picked.worktree.branch }
      : undefined
  );

  if (picked.worktree) {
    vscode.window.showInformationMessage(
      `Syncing ${picked.worktree.branch || picked.worktree.name} to ` +
        `${connectionLabel(service.getConfig() as any)}. Nothing is uploaded ` +
        'until a file changes there; use "SFTP: Sync Local -> Remote" to push ' +
        'the whole branch now.'
    );
  }
}

/**
 * Noticing a checkout that did not exist a moment ago.
 *
 * Offered once, and only for a connection that is already syncing from
 * somewhere - being asked about worktrees on a project that has never used
 * this would be noise.
 */
async function offerNewWorktrees(service: FileService): Promise<void> {
  if (!storage) {
    return;
  }

  const id = stableId(service as any);
  const seen: { [id: string]: string[] } = storage.get(OFFERED, {});
  const known = seen[id] || [];
  const found = await worktreesOf(service.baseDir);
  const fresh = found.filter(
    each => !each.isMain && each.exists && known.indexOf(each.root) === -1
  );

  seen[id] = found.filter(each => !each.isMain).map(each => each.root);
  await storage.update(OFFERED, seen);

  if (known.length === 0 || fresh.length === 0) {
    // Nothing known yet means this is the first look; recording what is there
    // is enough, and asking about checkouts that predate the feature is not
    // an interruption anybody asked for.
    return;
  }

  const one = fresh[0];
  const where = connectionLabel(service.getConfig() as any);
  const answer = await vscode.window.showInformationMessage(
    `New worktree ${one.branch || one.name}. Deploy it to ${where} instead?`,
    'Sync it',
    'Not now'
  );

  if (answer === 'Sync it') {
    await remember(service, { root: one.root, branch: one.branch });
  }
}

export function initWorktreeSync(context: vscode.ExtensionContext): void {
  storage = context.globalState;

  const start = async () => {
    for (const service of getAllFileService()) {
      const chosen = activeWorktree(service);
      const id = stableId(service as any);

      if (chosen && !watching.has(id)) {
        watching.set(id, watchWorktree(service, chosen));
      }

      const registry = await worktreeRegistryOf(service.baseDir);
      if (!registry) {
        continue;
      }

      // One folder, not recursive: a worktree appearing is a directory
      // appearing here, and git writes it before the checkout is usable.
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(registry), '*')
      );
      const look = () => {
        offerNewWorktrees(service).catch(error =>
          logger.debug(`could not look at the worktrees: ${error.message}`)
        );
      };

      watcher.onDidCreate(look);
      context.subscriptions.push(watcher);

      look();
    }
  };

  context.subscriptions.push({
    dispose: () => {
      Array.from(watching.keys()).forEach(stopWatching);
      settling.forEach(pending => clearTimeout(pending));
      settling.clear();
    },
  });

  start().catch(error =>
    logger.debug(`could not start worktree sync: ${error.message}`)
  );
}
