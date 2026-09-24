import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import logger, { withConnection } from '../logger';
import connectionLabel from '../core/connectionLabel';
import { UResource, FileService } from '../core';
import { removeRemote } from '../fileHandlers';
import { uploadMany } from '../fileHandlers/uploadMany';
import { getAllFileService } from './serviceManager';
import { stableId } from '../mcp/identity';
import { Worktree } from '../core/worktrees';
import { changesIn } from '../core/worktreeChanges';
import * as fse from 'fs-extra';
import { checkoutsOf, lastEditIn } from '../core/clones';
import { gitIgnoreIn, IgnoreLookup } from '../core/gitIgnored';
import { indexWrittenAt, trackedIn, vanished } from '../core/trackedFiles';
import { everDeletedIn, stillGoneIn } from '../core/removedFromHistory';
import {
  claim,
  keep,
  KEEP_EVERY,
  release,
} from '../core/autosyncLock';
import SyncQueue, { QueuedOp, resumed } from '../core/syncQueue';
import isNotFound from '../core/notFound';
import {
  clearToOverwrite,
  endSession,
  startSession,
  sweepFor,
} from './autosyncBackup';
import { describeAge } from '../mcp/localHistory';
import { getUserSetting } from '../host';

/**
 * Deploying continuously from a folder, chosen rather than assumed.
 *
 * Two things at once, because they are the same thing. An agent working on a
 * branch gets its own git worktree, usually nowhere near the folder in this
 * window, and until now the only way to deploy one was to start something
 * inside it by hand. And a project that is not a repository at all - which is
 * most of the connections here - has no way to say "keep this folder on the
 * server" short of writing a `watcher` block into `sftp.json`.
 *
 * Both are: watch a folder, upload what changes. Where there are worktrees
 * they are what you choose between; where there are none there is one
 * candidate, the folder itself, and choosing it turns continuous sync on.
 *
 * **One writer.** A connection has one remote path, and two sources writing to
 * it would leave whichever saved last. So a connection syncs from exactly one
 * folder at a time, and while it does, the window's own upload-on-save for
 * that connection stands down - the watcher covers saves too, and covers the
 * changes a save never sees. Nothing starts on its own: a worktree that
 * appears is offered, never adopted.
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

/** How long to wait after a failed upload before trying it again. */
const COOLDOWN = 5000;

/** How often the queue is looked at. Not how often anything is uploaded. */
const TICK = 500;

/** How often git's index is checked for files that left the project. */
const INDEX_EVERY = 2000;

/** How often to look at whether the work has moved to another checkout. */
const LOOK_EVERY = 60 * 1000;

/**
 * How recently another checkout must have been written in to be worth
 * mentioning. One touched last week is not where the work is, however it
 * compares to the one being deployed.
 */
const BUSY_WITHIN = 30 * 60 * 1000;

/** What is waiting to go up, per connection, across windows. */
const OUTSTANDING = 'sftp.autosyncOutstanding';

/** When each connection last knew what its folder looked like. */
const SEEN = 'sftp.autosyncSeen';

/** How often that mark is moved forward while a connection is watching. */
const MARK_EVERY = 30 * 1000;

interface Chosen {
  root: string;
  branch?: string;
}

let storage: vscode.Memento | undefined;

/** Where the one-writer claims live, shared by every window on this machine. */
let claimRoot = '';

/**
 * This window, as far as the claims are concerned.
 *
 * New on every activation, which is what is wanted: a window that was killed
 * never comes back as itself, so its claim ages out rather than being
 * inherited by something that knows nothing about it.
 */
const thisWindow = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 10)}`;

/**
 * Fired whenever a connection starts or stops autosyncing, so anything
 * showing that can say so without polling.
 *
 * Built on first use rather than on import: a module that constructs editor
 * objects while it is being loaded cannot be loaded by anything that is not
 * the editor, and two of these are read by tests that have no `vscode` at all.
 */
let changed: vscode.EventEmitter<void> | undefined;

function announcer(): vscode.EventEmitter<void> {
  if (!changed) {
    changed = new vscode.EventEmitter<void>();
  }

  return changed;
}

export const onDidChangeAutosync: vscode.Event<void> = listener =>
  announcer().event(listener);

/**
 * Everything one syncing connection is running.
 *
 * The queue is the interesting part: settling, retrying and remembering are
 * one structure rather than three, because they are three views of the same
 * question - what is waiting, and when may it go.
 */
interface Live {
  root: string;
  /**
   * The connection this is bound to.
   *
   * Held, not looked up, because saving `sftp.json` disposes every service for
   * that workspace and builds new ones - and a watcher still holding the old
   * one would be uploading down a connection nobody owns any more.
   */
  service: FileService;
  held: vscode.Disposable[];
  queue: SyncQueue;
  ignored: IgnoreLookup;
  tick: any;
  /** True while a flush is in flight, so ticks do not overlap. */
  working: boolean;
  /**
   * What git was tracking when this was last looked at, and when git last
   * wrote the index. Undefined outside a repository, where there is no index
   * to compare against and deletions can only come from the watcher.
   */
  tracked?: Set<string>;
  indexAt?: number;
  lookedAt: number;
}

const live = new Map<string, Live>();


const chosenAll = (): { [id: string]: Chosen } =>
  (storage && storage.get(REMEMBERED, {})) || {};

export function activeWorktree(service: FileService): Chosen | undefined {
  return chosenAll()[stableId(service as any)];
}

export interface AutosyncState {
  /** The branch, or the folder's name when it is not a checkout. */
  label: string;
  /** The folder being deployed. */
  root: string;
  /**
   * Whether that folder is somewhere other than the one this window has open.
   *
   * The difference people actually need: syncing this window's own folder is
   * the ordinary case and your saves still go up. Syncing a checkout that is
   * not open here means this window's saves are standing down and someone
   * else's work is what reaches the server - which is worth seeing without
   * opening a menu to find out.
   */
  external: boolean;
}

/** What a connection is autosyncing, if it is. */
export function autosyncState(service: FileService): AutosyncState | undefined {
  const chosen = activeWorktree(service);
  if (!chosen) {
    return undefined;
  }

  return {
    label: chosen.branch || path.basename(chosen.root),
    root: chosen.root,
    external: !samePath(chosen.root, service.baseDir),
  };
}

/** What to show beside a connection that is autosyncing, if it is. */
export function autosyncLabel(service: FileService): string | undefined {
  const state = autosyncState(service);
  return state && state.label;
}

/**
 * Whether this connection's own upload-on-save should stand down.
 *
 * Whenever anything is syncing continuously, including this window's own
 * folder: two mechanisms uploading the same save is one upload too many, and
 * the watcher sees everything upload-on-save sees. The cost is that a save
 * goes up when it has settled rather than the instant it is written.
 */
export function pausedFor(service: FileService): Chosen | undefined {
  return activeWorktree(service);
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
        `[autosync] upload-on-save is standing down: this connection autosyncs ` +
          `${chosen.branch || chosen.root}. ` +
          '"SFTP: Stop Autosync Worktree" hands it back.'
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

/** Where a file in the watched folder lands on the server. */
function remotePathOf(service: FileService, root: string, file: string): string {
  return contextFor(service, root, file).target.remoteFsPath;
}

/**
 * A deletion, which has no transfer log of its own.
 *
 * Uploads are written to the output panel by the connection's own transfer
 * listener, in the same line and the same shape as any other upload. Removals
 * go through a different handler that says nothing, so this says it.
 */
async function remove(
  service: FileService,
  root: string,
  file: string
): Promise<void> {
  await removeRemote(contextFor(service, root, file) as any);
  logger.info(`[autosync] removed ${path.relative(root, file)}`);
}

/**
 * Never uploaded, whatever anybody's rules say.
 *
 * `.git` because it is the repository, not the site. `.vscode` because it
 * holds `sftp.json`, which holds the password for the very server this would
 * put it on - and relying on someone having gitignored it is relying on
 * someone. `.claude` for the same reason as `autosync.sh` excludes it: it is
 * an agent's workspace, including its worktrees, and none of it is the
 * deployment.
 */
const NEVER_UPLOADED = ['.git', '.vscode', '.claude'];

/**
 * A checkout living inside a folder that another checkout never uploads.
 *
 * Agent tooling keeps its per-task worktrees under `.claude/worktrees/`, which
 * git registers exactly like any other worktree - so they arrive in the list
 * looking like four more things you could deploy. They are not. They sit
 * inside a folder that is excluded from the very deployment they are nested
 * in, and the thing that gets deployed is the checkout around them.
 *
 * Judged against the other candidates rather than by looking for `.claude` in
 * the path, so a project that happens to live under a folder of that name
 * somewhere above is not caught by it.
 */
function nestedInScratch(one: Worktree, others: Worktree[]): boolean {
  return others.some(other => {
    if (samePath(other.root, one.root)) {
      return false;
    }

    const relative = path.relative(other.root, one.root);
    if (relative === '' || relative.indexOf('..') === 0 || path.isAbsolute(relative)) {
      return false;
    }

    return NEVER_UPLOADED.indexOf(relative.split(path.sep)[0]) !== -1;
  });
}

function isGitPlumbing(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return NEVER_UPLOADED.some(
    name => relative === name || relative.indexOf(`${name}${path.sep}`) === 0
  );
}

function seconds(key: string, fallback: number): number {
  const given = getUserSetting('sftp').get<number>(key, fallback / 1000);
  return typeof given === 'number' && given >= 0 ? given * 1000 : fallback;
}

/**
 * Everything due, sent.
 *
 * The order is not arbitrary. Git is asked about the whole batch at once,
 * because asking per file was eleven milliseconds each and an `npm install`
 * is forty thousand of them. Then the server's copy is kept, before anything
 * is written over. Only then does anything go up, and a file that fails at
 * any of those steps stays in the queue rather than being logged and lost.
 */
/**
 * Files that have left the project since this was last looked at.
 *
 * Git's index is the only thing that knows the difference between a file being
 * gone for a moment - a build clearing a folder, an editor swapping a file out
 * and back, a branch switch rewriting half the tree - and a file no longer
 * being part of what should be deployed. So that is what is compared, and only
 * when git has actually written it, which costs one `lstat` to find out.
 */
async function whatLeftTheProject(running: Live, now: number): Promise<string[]> {
  if (now - running.lookedAt < INDEX_EVERY) {
    return [];
  }
  running.lookedAt = now;

  const writtenAt = await indexWrittenAt(running.root);
  if (writtenAt === undefined) {
    return []; // Not a repository. The watcher is the only signal there is.
  }

  if (running.tracked && writtenAt === running.indexAt) {
    return [];
  }

  const tracked = await trackedIn(running.root);
  if (!tracked) {
    // Git could not answer. "Nothing is tracked" and "there is no git here"
    // lead to opposite actions, and one of them empties a live server.
    return [];
  }

  running.indexAt = writtenAt;

  const before = running.tracked;
  running.tracked = tracked;

  // The first look is what everything after it is compared against. Files that
  // left before anybody was watching are not this session's to remove.
  return before ? vanished(before, tracked) : [];
}

async function flush(service: FileService, id: string): Promise<void> {
  const running = live.get(id);
  if (!running || running.working) {
    return;
  }

  const now = Date.now();

  const gone = await whatLeftTheProject(running, now).catch(() => [] as string[]);
  gone.forEach(file => running.queue.put(file, 'remove', now));
  if (gone.length > 0) {
    logger
      .for(connectionLabel(service.getConfig() as any))
      .info(
        `[autosync] ${gone.length} file${gone.length === 1 ? '' : 's'} left the ` +
          'branch; removing from the server.'
      );
  }

  const due = running.queue.due(now);
  if (due.length === 0) {
    return;
  }

  running.working = true;

  const root = running.root;
  const label = connectionLabel(service.getConfig() as any);

  try {
    await withConnection(label, async () => {
      const mine = due.filter(one => !isGitPlumbing(root, one.file));

      // Git's answer for the whole batch, in one question.
      const rejected = await running.ignored.ignoredAmong(mine.map(one => one.file));

      const sending = mine.filter(
        one =>
          !rejected.has(one.file) &&
          !ignoredInWorktree(service, root, one.file)
      );

      // Anything git or the connection rejects was never work; it leaves the
      // queue without being counted as done or failed.
      due
        .filter(one => sending.indexOf(one) === -1)
        .forEach(one => running.queue.drop(one.file));

      // Only files. A watcher reports a directory whenever anything inside it
      // changes, and that something has its own event - while `transfer()`
      // dispatches a directory to `transferFolder`, which would re-upload the
      // whole tree underneath it. The queue held the watched root itself.
      const wanted = sending.filter(one => one.op === 'upload');
      const uploads: QueuedOp[] = [];

      for (const one of wanted) {
        try {
          if ((await fse.lstat(one.file)).isFile()) {
            uploads.push(one);
            continue;
          }
        } catch (error) {
          // Gone between the event and now. Nothing to send.
        }

        running.queue.drop(one.file);
      }

      const removals = sending.filter(one => one.op === 'remove');

      // Held back because the server's copy could not be kept, which is a
      // reason to try again rather than a reason to give up.
      /** Deleted between being noticed and being sent - a test's scratch file. */
      const vanished = new Set<string>();

      // The connection's own uploader, one scheduler for the batch: the same
      // concurrency, verification and temp-file handling every other upload
      // gets, over the connection that is already open.
      const result = await uploadMany(
        service,
        uploads.map(one => ({
          local: one.file,
          remote: remotePathOf(service, root, one.file),
        })),
        {
          // A file the queue is going to try again is not a file to interrupt
          // anybody about; the transfer log still records every attempt.
          announce: false,
          allow: async one => {
            // Asked here rather than only before the batch, because the gap
            // between the two is where a test's temporary files live. Gone is
            // not a failure and must not read as one: an upload that reports
            // `ENOENT` goes back in the queue, and a file that no longer
            // exists never stops reporting it.
            if (!(await fse.pathExists(one.local))) {
              vanished.add(one.local);
              return false;
            }

            // A file whose copy could not be kept is simply not sent; the
            // loop below puts it back in the queue with everything else that
            // did not arrive.
            return clearToOverwrite(service, one.remote);
          },
        }
      );

      const sent = new Set(result.uploaded);
      const now2 = Date.now();
      let waiting = 0;

      for (const one of uploads) {
        if (sent.has(one.file)) {
          running.queue.done(one.file);
          continue;
        }

        // Whether it is worth trying again is a question about the file, not
        // about the error: one that has been deleted since will fail the same
        // way for ever.
        if (vanished.has(one.file) || !(await fse.pathExists(one.file))) {
          running.queue.drop(one.file);
          logger.debug(`[autosync] ${one.file} is gone; not sending it.`);
          continue;
        }

        running.queue.failed(one.file, now2, one);
        waiting += 1;
      }

      if (waiting > 0) {
        logger.info(
          `[autosync] ${waiting} file${waiting === 1 ? '' : 's'} did not go up; ` +
            'waiting to try again.'
        );
      }

      for (const one of removals) {
        // Where it goes is worked out on this machine, from nothing that
        // changes between attempts, so a failure here is the same failure
        // every time. Said once and let go, not retried for ever.
        let remotePath: string;
        try {
          remotePath = remotePathOf(service, root, one.file);
        } catch (error) {
          running.queue.drop(one.file);
          logger.error(
            error,
            `[autosync] cannot tell where ${one.file} is on the server; not removing it`
          );
          continue;
        }

        try {
          // A delete destroys the server's copy as surely as an overwrite
          // does, and unlike an overwrite there is nothing left to compare
          // against afterwards. Same rule: no copy kept, nothing removed.
          const cleared = await clearToOverwrite(service, remotePath);

          if (!cleared) {
            running.queue.failed(one.file, Date.now(), one);
            continue;
          }

          await remove(service, root, one.file);
          running.queue.done(one.file);
        } catch (error) {
          // Already gone from the server is what was wanted. Asking again
          // would get the same answer for ever.
          if (isNotFound(error)) {
            running.queue.done(one.file);
            logger.debug(`[autosync] ${one.file} was not on the server; nothing to remove.`);
            continue;
          }

          running.queue.failed(one.file, Date.now(), one);

          // The whole error the first time. After that the queue keeps
          // trying every few minutes, and a stack trace each time buries
          // everything else in the log.
          if (one.tries === 0) {
            logger.error(error, `autosync delete ${one.file}`);
          } else {
            logger.warn(
              `[autosync] still cannot remove ${path.relative(root, one.file)} ` +
                `(attempt ${one.tries + 1}): ${(error && error.message) || error}`
            );
          }
        }
      }
    });
  } finally {
    running.working = false;
    await writeDownOutstanding(id, running.queue);
    // Everything that had arrived when this batch started has now been dealt
    // with, so that is how far this folder is known about.
    await markSeen(id, now);
  }
}

async function writeDownOutstanding(id: string, queue: SyncQueue): Promise<void> {
  if (!storage) {
    return;
  }

  const all: { [id: string]: QueuedOp[] } = storage.get(OUTSTANDING, {});

  if (queue.size === 0) {
    if (!all[id]) {
      return;
    }
    delete all[id];
  } else {
    all[id] = queue.toJSON();
  }

  await storage.update(OUTSTANDING, all);
}

function seenAt(id: string): number | undefined {
  const all: { [id: string]: number } = (storage && storage.get(SEEN, {})) || {};
  return typeof all[id] === 'number' ? all[id] : undefined;
}

/**
 * Moves the mark forward: everything in this folder is known about up to here.
 *
 * Moved often rather than once, because what it costs if it is stale is a
 * handful of files uploaded again - and what it costs if it is missing is a
 * change that never goes up at all.
 */
async function markSeen(id: string, when: number): Promise<void> {
  if (!storage) {
    return;
  }

  const all: { [id: string]: number } = storage.get(SEEN, {});
  all[id] = when;
  await storage.update(SEEN, all);
}

async function forgetSeen(id: string): Promise<void> {
  if (!storage) {
    return;
  }

  const all: { [id: string]: number } = storage.get(SEEN, {});
  if (!(id in all)) {
    return;
  }

  delete all[id];
  await storage.update(SEEN, all);
}

async function forgetOutstanding(id: string): Promise<void> {
  if (!storage) {
    return;
  }

  const all: { [id: string]: QueuedOp[] } = storage.get(OUTSTANDING, {});
  if (!all[id]) {
    return;
  }

  delete all[id];
  await storage.update(OUTSTANDING, all);
}

function outstandingFor(id: string): QueuedOp[] {
  const all: { [id: string]: QueuedOp[] } =
    (storage && storage.get(OUTSTANDING, {})) || {};
  return all[id] || [];
}

/**
 * What happened to the folder while nobody was watching it.
 *
 * Quitting the editor stops the watcher; the agent writing into that checkout
 * does not stop with it. So the first thing a resumed connection does is ask
 * the disk what has been written since the mark, and queue it - which is the
 * same question the time-window catch-up asks, against a moment that was
 * recorded rather than chosen.
 *
 * Uploads only. A file deleted while the window was closed leaves nothing
 * behind to notice, and reconstructing that would mean keeping a list of every
 * file in the checkout - a lot of bookkeeping for the rarer half of a case
 * that `watcher.autoDelete` has to be on for at all.
 */
async function catchUpOnWhatWasMissed(
  service: FileService,
  id: string,
  running: Live,
  since: number
): Promise<void> {
  const changed = await writtenSince(running.root, since, running.ignored, service);
  if (changed.length === 0) {
    return;
  }

  await newestFirst(changed);

  const now = Date.now();
  changed.forEach(file => running.queue.put(file, 'upload', now));

  const where = connectionLabel(service.getConfig() as any);
  logger
    .for(where)
    .info(
      `[autosync] ${changed.length} file${changed.length === 1 ? '' : 's'} ` +
        `changed while this window was closed; catching ${where} up.`
    );

  const stop = 'Stop';
  const answer = await vscode.window.showInformationMessage(
    `${changed.length} file${changed.length === 1 ? '' : 's'} changed in ` +
      `${running.root} while the window was closed. Catching ${where} up.`,
    stop
  );

  if (answer === stop) {
    changed.forEach(file => running.queue.drop(file));
    logger.for(where).info('[autosync] catch-up stopped.');
  }
}

function watchWorktree(service: FileService, chosen: Chosen): Live {
  const config = service.getConfig();
  const root = chosen.root;
  const id = stableId(service as any);

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(root), '**/*')
  );

  const queue = resumed(
    {
      settle: seconds('autosync.settleSeconds', SETTLE),
      cooldown: seconds('autosync.retrySeconds', COOLDOWN),
    },
    outstandingFor(id),
    Date.now()
  );

  // Git is asked about the checkout being watched, not about the one in this
  // window: they are different repositories with different rules.
  const ignored = gitIgnoreIn(root);

  const running: Live = {
    root,
    service,
    queue,
    ignored,
    working: false,
    lookedAt: 0,
    held: [watcher],
    tick: setInterval(() => {
      flush(service, id).catch(error =>
        logger.debug(`could not send what is due: ${error.message}`)
      );
    }, TICK),
  };

  const changed = (uri: vscode.Uri) => {
    if (isGitPlumbing(root, uri.fsPath)) {
      return;
    }

    // A rule written is a rule that applies from now on, including to what is
    // already waiting.
    if (path.basename(uri.fsPath) === '.gitignore') {
      ignored.forget();
    }

    queue.put(uri.fsPath, 'upload', Date.now());
  };

  watcher.onDidCreate(changed);
  watcher.onDidChange(changed);
  watcher.onDidDelete(uri => {
    if (isGitPlumbing(root, uri.fsPath)) {
      return;
    }

    // A file disappearing is not by itself a reason to take it off a live
    // server: a build clears a folder, an editor swaps a file out and back, a
    // branch switch rewrites half the tree. Git's index says which of those
    // was a removal from the project, and the tick watches it.
    //
    // So this only queues a deletion where there is no index to consult - a
    // folder that is not a repository - and there it stays behind
    // `watcher.autoDelete`, as it always has.
    const watcherConfig = (config as any).watcher;
    if (!running.tracked && watcherConfig && watcherConfig.autoDelete) {
      queue.put(uri.fsPath, 'remove', Date.now());
      return;
    }

    // An upload that has not happened yet is not wanted for a file that is
    // gone, whatever happens about removing it from the server.
    const waiting = queue.all().find(one => one.file === uri.fsPath);
    if (waiting && waiting.op === 'upload') {
      queue.drop(uri.fsPath);
    }
  });

  logger
    .for(connectionLabel(config as any))
    .info(
      `[autosync] syncing ${chosen.branch || root} from ${root}` +
        (samePath(root, service.baseDir) ? '' : '; this window is paused')
    );

  if (queue.size > 0) {
    logger
      .for(connectionLabel(config as any))
      .info(
        `[autosync] picking up ${queue.size} file` +
          `${queue.size === 1 ? '' : 's'} left over from last time.`
      );
  }

  // The mark moves on its own while this is running, so that a window that is
  // killed - rather than closed - still leaves a recent one behind.
  const heartbeat = setInterval(() => {
    markSeen(id, Date.now()).catch(() => undefined);
  }, MARK_EVERY);
  running.held.push({ dispose: () => clearInterval(heartbeat) });

  // And says, in the one place every window can see, that this one is the
  // writer. If another window takes it over, this stands down rather than both
  // of them writing to the same remote path.
  const holding = setInterval(() => {
    keep(claimRoot, id, thisWindow, root)
      .then(ours => {
        if (ours) {
          return;
        }

        logger
          .for(connectionLabel(config as any))
          .warn(
            '[autosync] another window has taken this connection over; ' +
              'standing down here.'
          );
        stopWatching(id);
        vscode.window.showWarningMessage(
          `${connectionLabel(config as any)} is now being autosynced by another ` +
            'window. This one has stopped.'
        );
      })
      .catch(() => undefined);
  }, KEEP_EVERY);
  running.held.push({ dispose: () => clearInterval(holding) });

  // And keeps an eye on whether the work has moved to another checkout of the
  // same project, which is a question with no event behind it: an agent
  // picking up a checkout that already exists creates nothing and fires
  // nothing.
  const looking = setInterval(() => {
    offerSomewhereBusier(service).catch(error =>
      logger.debug(`could not look at the other checkouts: ${error.message}`)
    );
  }, LOOK_EVERY);
  running.held.push({ dispose: () => clearInterval(looking) });

  const mark = seenAt(id);
  markSeen(id, Date.now()).catch(() => undefined);

  if (mark) {
    // After the watcher is listening, not before: anything written during the
    // scan is then caught by the watcher rather than falling between the two.
    catchUpOnWhatWasMissed(service, id, running, mark).catch(error =>
      logger.debug(`could not work out what was missed: ${error.message}`)
    );
  }

  return running;
}

function stopWatching(id: string): void {
  const running = live.get(id);
  if (!running) {
    return;
  }

  clearInterval(running.tick);
  running.held.forEach(one => one.dispose());
  live.delete(id);

  // Given up rather than left to age out, so another window can start at once
  // instead of waiting for this one to look abandoned.
  release(claimRoot, id, thisWindow).catch(() => undefined);
}

/**
 * Lets a menu show `Stop` only when something is running.
 *
 * One key for the window rather than one per connection, because that is what
 * a `when` clause can see. It says "something here is syncing a worktree", and
 * the command itself works out whether that is the connection you clicked.
 */
async function sayWhetherAnythingIsSyncing(): Promise<void> {
  const all = chosenAll();

  await vscode.commands.executeCommand(
    'setContext',
    'sftp.autosyncWorktreeing',
    Object.keys(all).length > 0
  );

  // A separate question from "is anything syncing": the commands that lead to
  // the synced folder only make sense when it is one this window does not
  // already have open.
  const elsewhere = getAllFileService().some(service => {
    const state = autosyncState(service);
    return Boolean(state && state.external);
  });

  await vscode.commands.executeCommand(
    'setContext',
    'sftp.autosyncElsewhere',
    elsewhere
  );

  // The folders in this window whose connection is syncing, so the file
  // explorer can be precise after all. A `when` clause cannot ask about the
  // item it is on - but it can ask whether `resourcePath` is *in* a list, and
  // a list is something we can keep. Without this the only question available
  // there was "is anything in this window syncing", which put `Stop` on every
  // project or on none.
  const syncing: string[] = [];
  getAllFileService().forEach(service => {
    if (!autosyncState(service)) {
      return;
    }

    syncing.push(service.baseDir);
    // And the folder being deployed, when the window happens to have it open.
    const chosen = activeWorktree(service);
    if (chosen && !samePath(chosen.root, service.baseDir)) {
      syncing.push(chosen.root);
    }
  });

  await vscode.commands.executeCommand(
    'setContext',
    'sftp.autosyncPaths',
    syncing
  );

  // The one list behind both the menu and the mark in the file explorer, so
  // when a project shows neither, what it should have matched is on record.
  logger.debug(
    `[autosync] folders marked in the file explorer: ${
      syncing.length ? syncing.join(', ') : 'none'
    }`
  );
}

/**
 * Whether this window may be the one writing to this connection.
 *
 * Asks when another window already is, rather than starting alongside it:
 * two sources writing to one remote path leaves whichever landed last, which
 * is the failure nobody notices until the site is wrong.
 */
async function mayWrite(
  service: FileService,
  id: string,
  root: string
): Promise<boolean> {
  const taken = await claim(claimRoot, id, thisWindow, root).catch(
    () => ({ held: true } as const)
  );

  if (taken.held) {
    return true;
  }

  const other = (taken as any).by;
  const takeOver = 'Take it over';

  const answer = await vscode.window.showWarningMessage(
    `Another window is already autosyncing ` +
      `${connectionLabel(service.getConfig() as any)}, from ${other.root}.`,
    {
      modal: true,
      detail:
        'A connection has one remote path, so only one folder can deploy to ' +
        'it. Taking it over stops the sync in that window; it will say so ' +
        'there within a few seconds.',
    },
    takeOver
  );

  if (answer !== takeOver) {
    return false;
  }

  await claim(claimRoot, id, thisWindow, root, true).catch(() => undefined);

  return true;
}

/** True when the choice took effect; false when another window kept it. */
async function remember(
  service: FileService,
  chosen?: Chosen
): Promise<boolean> {
  if (!storage) {
    return false;
  }

  const id = stableId(service as any);

  if (chosen && !live.has(id) && !(await mayWrite(service, id, chosen.root))) {
    return false;
  }

  const all = chosenAll();

  if (chosen) {
    all[id] = chosen;
  } else {
    delete all[id];
  }

  await storage.update(REMEMBERED, all);
  await sayWhetherAnythingIsSyncing();
  announcer().fire();
  said.delete(`${id}|${chosen ? chosen.root : ''}`);

  const stillWaiting = (live.get(id) && live.get(id)!.queue.size) || 0;

  stopWatching(id);
  if (chosen) {
    // One session per run: the moment a restore can be asked to go back to.
    startSession(service);
    sweepFor(service);
    live.set(id, watchWorktree(service, chosen));
  } else {
    endSession(service);

    // Stopping is a decision about the queue too: nothing is going to drain it
    // once nobody is watching, so it is dropped and said out loud rather than
    // left to reappear a week later.
    await forgetOutstanding(id);
    await forgetSeen(id);

    logger
      .for(connectionLabel(service.getConfig() as any))
      .info(
        '[autosync] stopped; this window uploads again.' +
          (stillWaiting
            ? ` ${stillWaiting} file${stillWaiting === 1 ? ' was' : 's were'} ` +
              'still waiting and will not be sent.'
            : '')
      );

    if (stillWaiting > 0) {
      vscode.window.showWarningMessage(
        `${stillWaiting} file${stillWaiting === 1 ? '' : 's'} had not reached ` +
          `${connectionLabel(service.getConfig() as any)} yet. ` +
          'Use "SFTP: Sync Local -> Remote" if you still want them there.'
      );
    }
  }

  return true;
}

export interface CatchUp {
  /** The folder being deployed, context and all. */
  syncRoot: string;
  /** The checkout it sits in, which is what git answers about. */
  checkout: string;
  branch?: string;
  /** The branch this server has been getting until now, if it is known. */
  against?: string;
}

/** A window of time to catch up over, when git cannot say what changed. */
const WINDOWS = [
  { label: 'Changed in the last hour', hours: 1 },
  { label: 'Changed in the last 24 hours', hours: 24 },
  { label: 'Changed in the last 7 days', hours: 24 * 7 },
  { label: 'Everything in the folder', hours: 0 },
];

/**
 * Every file under `root` written since `since`, ignoring what git ignores.
 *
 * The answer git cannot give. A plain folder has no history, and neither does
 * a checkout sitting on a commit rather than a branch, so the only thing left
 * to ask is the disk: what has been written lately.
 */
async function writtenSince(
  root: string,
  since: number,
  ignored: IgnoreLookup,
  service: FileService
): Promise<string[]> {
  const found: string[] = [];

  const visit = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await fse.readdir(dir);
    } catch (error) {
      return;
    }

    const below: string[] = [];
    const here: string[] = [];

    for (const name of entries) {
      const full = path.join(dir, name);
      if (isGitPlumbing(root, full)) {
        continue;
      }

      let stat;
      try {
        stat = await fse.lstat(full);
      } catch (error) {
        continue;
      }

      if (stat.isDirectory()) {
        below.push(full);
      } else if (stat.isFile() && stat.mtimeMs >= since) {
        here.push(full);
      }
    }

    // Git is asked about a directory's worth at a time, not a file at a time,
    // and a directory it rejects is not descended into at all.
    const rejected = await ignored.ignoredAmong(below.concat(here));

    here.forEach(file => {
      if (!rejected.has(file) && !ignoredInWorktree(service, root, file)) {
        found.push(file);
      }
    });

    for (const dir2 of below) {
      if (!rejected.has(dir2)) {
        await visit(dir2);
      }
    }
  };

  await visit(root);

  return found;
}

/**
 * Sorts a list of files so the most recently written go up first.
 *
 * On a catch-up of any size the order is the difference between seeing your
 * last edit on the server in a second and seeing it in four minutes. Same
 * reason `autosync.sh` sorts by mtime descending before every upload pass.
 */
async function newestFirst(files: string[]): Promise<void> {
  const when = new Map<string, number>();

  await Promise.all(
    files.map(async file => {
      try {
        when.set(file, (await fse.lstat(file)).mtimeMs);
      } catch (error) {
        when.set(file, 0);
      }
    })
  );

  files.sort((a, b) => (when.get(b) || 0) - (when.get(a) || 0));
}

/** What git says this branch has that the deployed one does not. */
async function fromGit(
  service: FileService,
  plan: CatchUp,
  base?: string
): Promise<{ upload: string[]; remove: string[]; against?: string } | undefined> {
  const changes = await changesIn(plan.checkout, base);
  const inside = (file: string) => {
    const relative = path.relative(plan.syncRoot, file);
    return (
      relative !== '' &&
      relative.indexOf('..') !== 0 &&
      !path.isAbsolute(relative) &&
      !isGitPlumbing(plan.syncRoot, file) &&
      !ignoredInWorktree(service, plan.syncRoot, file)
    );
  };

  return {
    upload: changes.changed.filter(inside),
    remove: changes.deleted.filter(inside),
    against: changes.base,
  };
}

/**
 * Everything the folder has moved on by, uploaded now.
 *
 * Picking a folder usually happens after the work has started: an agent has
 * been writing for twenty minutes before anybody looks. Watching from that
 * moment leaves all of it behind.
 *
 * Where there is a branch, git answers it exactly and for nothing: the files
 * this branch changed, and the ones not committed yet. Where there is not - a
 * plain project folder, or a checkout sitting on a commit - the disk answers
 * it approximately, by when things were last written, which is the question
 * `autosync.sh` asks as "sync the last N hours" and is the only one available.
 *
 * Offered, with the count, rather than done: 174 files is a deploy, and a
 * deploy is not something to start because somebody chose from a list.
 */
async function offerToCatchUp(service: FileService, plan: CatchUp): Promise<void> {
  const where = connectionLabel(service.getConfig() as any);
  const ignored = gitIgnoreIn(plan.checkout);

  // Two different questions, and both are worth offering. What the branch
  // changed assumes the server already has the branch this window is on. What
  // is not committed assumes nothing, and is the backfill `autosync.sh` does
  // even in its "monitor only" mode.
  const fromBranch = plan.branch ? await fromGit(service, plan, plan.against) : undefined;
  const uncommitted = plan.branch ? await fromGit(service, plan) : undefined;

  type Choice = {
    label: string;
    description: string;
    hours?: number;
    from?: { upload: string[]; remove: string[] };
  };
  const choices: Choice[] = [];

  if (fromBranch && fromBranch.upload.length > 0 && fromBranch.against) {
    choices.push({
      label: `Upload what this branch changed (${fromBranch.upload.length})`,
      description: `against ${fromBranch.against}`,
      from: fromBranch,
    });
  }

  if (uncommitted && uncommitted.upload.length > 0) {
    choices.push({
      label: `Upload what is not committed (${uncommitted.upload.length})`,
      description: 'assumes nothing about what the server has',
      from: uncommitted,
    });
  }

  WINDOWS.forEach(window =>
    choices.push({
      label: window.label,
      description: window.hours ? 'by when it was written' : 'everything, ignored files aside',
      hours: window.hours,
    })
  );

  choices.push({ label: 'Nothing - watch from now', description: '' });

  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: `Catch ${where} up to ${plan.branch || plan.syncRoot} first?`,
  });

  if (!picked || (picked.hours === undefined && !picked.from)) {
    return;
  }

  let toUpload: string[];
  let toDelete: string[] = [];
  const wasEverything = picked.hours === 0;

  if (picked.from) {
    toUpload = picked.from.upload;
    toDelete = picked.from.remove;
  } else {
    const since = picked.hours ? Date.now() - picked.hours * 60 * 60 * 1000 : 0;
    toUpload = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'SFTP: looking at what changed\u2026',
      },
      () => writtenSince(plan.syncRoot, since, ignored, service)
    );
  }

  if (toUpload.length === 0) {
    vscode.window.showInformationMessage(`Nothing to catch ${where} up on.`);
    return;
  }

  await newestFirst(toUpload);

  // These came from git saying the files are no longer in the project, which
  // is a different statement from a watcher seeing one disappear - so they are
  // removed, and the confirmation says how many.
  const alsoGone =
    toDelete.length > 0
      ? ` ${toDelete.length} removed from the branch will be taken off the server.`
      : '';

  const answer = await vscode.window.showInformationMessage(
    `Upload ${toUpload.length} file${toUpload.length === 1 ? '' : 's'} to ${where}?` +
      alsoGone,
    { modal: false },
    `Upload ${toUpload.length}`,
    'Not now'
  );

  if (answer !== `Upload ${toUpload.length}`) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Catching ${where} up to ${plan.branch || plan.syncRoot}`,
      cancellable: true,
    },
    (progress, token) => withConnection(where, async () => {
      let done = 0;

      // The connection's own uploader, so concurrency, verification and temp
      // files are what they are everywhere else.
      const result = await uploadMany(
        service,
        toUpload.map(file => ({
          local: file,
          remote: remotePathOf(service, plan.syncRoot, file),
        })),
        {
          // One thing said about the batch at the end, rather than a dialog
          // for each of fifty files.
          announce: false,
          cancelled: () => token.isCancellationRequested,
          allow: upload => clearToOverwrite(service, upload.remote),
          onDone: (upload) => {
            done += 1;
            progress.report({
              increment: 100 / toUpload.length,
              message: `${done} of ${toUpload.length}: ${path.relative(
                plan.syncRoot,
                upload.local
              )}`,
            });
          },
        }
      );

      {
        for (const file of toDelete) {
          if (token.isCancellationRequested) {
            break;
          }

          const cleared = await clearToOverwrite(
            service,
            remotePathOf(service, plan.syncRoot, file)
          ).catch(() => false);

          if (!cleared) {
            continue;
          }

          await remove(service, plan.syncRoot, file).catch(error =>
            logger.error(error, `autosync catch-up delete ${file}`)
          );
        }
      }

      // Whatever did not make it is not lost: it goes where everything else
      // that failed goes, and is tried again.
      const running = live.get(stableId(service as any));
      if (running) {
        result.failed.forEach(one => running.queue.put(one.local, 'upload', Date.now()));
      }

      logger.info(
        `[autosync] caught up: ${result.uploaded.length} uploaded` +
          (result.failed.length ? `, ${result.failed.length} to retry` : '') +
          (toDelete.length ? `, ${toDelete.length} removed` : '') +
          '.'
      );
    })
  );

  // Uploading everything makes the server hold everything the project has. It
  // says nothing about what the project used to have and dropped, which is the
  // other half of what a fresh deploy means - offered separately, because
  // removing files is not a thing to fold silently into an upload.
  if (wasEverything && plan.branch) {
    const clean = 'Look';
    const answer = await vscode.window.showInformationMessage(
      `${where} now has everything in the folder. Look for files the project ` +
        'deleted that may still be on it?',
      clean,
      'Not now'
    );

    if (answer === clean) {
      await removeWhatWasDeleted(service);
    }
  }
}

/** Which folder a connection deploys, and the checkout it sits in. */
function deployedBy(service: FileService): { syncRoot: string; checkout: string } {
  const chosen = activeWorktree(service);
  if (chosen) {
    return { syncRoot: chosen.root, checkout: chosen.root };
  }

  return { syncRoot: service.baseDir, checkout: service.baseDir };
}

/**
 * The command: take off the server what the project deleted.
 *
 * Autosync removes files as they leave git's index, but only from the moment
 * it starts watching. Everything dropped before that is still on the server,
 * along with everything dropped in the years before any of this existed.
 *
 * Asked of git's history, never of the server. The other way round - list the
 * server, remove what is not on disk - answers a more complete question and a
 * far more dangerous one, because the answer includes every runtime directory,
 * upload folder and cache the site keeps and the repository ignores. Nothing
 * here can name a path the repository never tracked.
 */
export async function removeWhatWasDeleted(service: FileService): Promise<void> {
  const where = connectionLabel(service.getConfig() as any);
  const { syncRoot, checkout } = deployedBy(service);

  const deleted = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'SFTP: asking git what the project dropped\u2026',
    },
    () => everDeletedIn(checkout)
  );

  if (deleted === undefined) {
    vscode.window.showInformationMessage(
      `${syncRoot} is not a git repository, so there is no history to ask. ` +
        '"SFTP: Sync Local -> Remote" compares against the server instead.'
    );
    return;
  }

  const gone = await stillGoneIn(checkout, deleted);
  const mine = gone
    .map(file => path.join(checkout, file))
    .filter(
      file =>
        !isGitPlumbing(syncRoot, file) &&
        !ignoredInWorktree(service, syncRoot, file) &&
        path.relative(syncRoot, file).indexOf('..') !== 0
    );

  if (mine.length === 0) {
    vscode.window.showInformationMessage(
      `Nothing to remove from ${where}: everything the project deleted is ` +
        'already gone from it, or was never deployed.'
    );
    return;
  }

  const some = mine
    .slice(0, 8)
    .map(file => path.relative(syncRoot, file))
    .join('\n');

  const go = `Remove ${mine.length}`;
  const answer = await vscode.window.showWarningMessage(
    `Remove ${mine.length} file${mine.length === 1 ? '' : 's'} from ${where}?`,
    {
      modal: true,
      detail:
        `${some}${mine.length > 8 ? `\n…and ${mine.length - 8} more` : ''}\n\n` +
        'These were deleted from the project and may still be on the server. ' +
        'Only paths git once tracked are listed, so nothing the repository ' +
        'ignores - runtime data, uploads, caches - can appear here. Each one ' +
        'is copied off the server before it goes.',
    },
    go
  );

  if (answer !== go) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Removing what the project deleted from ${where}`,
      cancellable: true,
    },
    (progress, token) =>
      withConnection(where, async () => {
        let removed = 0;
        let kept = 0;

        for (const file of mine) {
          if (token.isCancellationRequested) {
            break;
          }

          progress.report({
            increment: 100 / mine.length,
            message: path.relative(syncRoot, file),
          });

          // Same rule as everywhere else: no copy, no removal.
          const cleared = await clearToOverwrite(
            service,
            remotePathOf(service, syncRoot, file)
          ).catch(() => false);

          if (!cleared) {
            kept += 1;
            continue;
          }

          try {
            await remove(service, syncRoot, file);
            removed += 1;
          } catch (error) {
            // A file that is not there is the outcome asked for.
            logger.debug(`could not remove ${file}: ${error.message}`);
          }
        }

        logger.info(
          `[cleanup] ${removed} removed from ${where}` +
            (kept ? `, ${kept} left alone (no copy could be kept)` : '') +
            '.'
        );

        vscode.window.showInformationMessage(
          `${removed} file${removed === 1 ? '' : 's'} removed from ${where}` +
            (kept ? `; ${kept} left alone because no copy could be kept.` : '.')
        );
      })
  );
}

/** The command: hand a connection back to the window it belongs to. */
export async function stopSyncing(service: FileService): Promise<void> {
  const chosen = activeWorktree(service);
  const where = connectionLabel(service.getConfig() as any);

  if (!chosen) {
    vscode.window.showInformationMessage(
      `${where} is already deploying from this window.`
    );
    return;
  }

  await remember(service, undefined);
  vscode.window.showInformationMessage(
    `${where} deploys from this window again. ` +
      `${chosen.branch || chosen.root} is no longer watched.`
  );
}

/**
 * Where to look for other checkouts of this project.
 *
 * The folder holding this one, always: a second checkout is usually a sibling
 * of the first. Beyond that, whatever `sftp.autosync.searchPaths` names, for
 * tooling that keeps its clones somewhere else entirely.
 */
function whereToLook(service: FileService): string[] {
  const configured = getUserSetting('sftp').get<string[]>(
    'autosync.searchPaths',
    []
  );

  // A setting anybody can edit, so it is read as what it might be rather than
  // as what it should be.
  const extra = (Array.isArray(configured) ? configured : [])
    .filter(one => typeof one === 'string' && one.trim() !== '')
    .map(one =>
      one.charAt(0) === '~' ? path.join(os.homedir(), one.slice(1)) : one
    );

  return [path.dirname(service.baseDir)].concat(extra);
}

/**
 * The part of a checkout this connection actually deploys.
 *
 * A connection with a `context` manages a folder inside the project, not the
 * project - `baseDir` is `<workspace>/<context>`, and `remotePath` is what
 * that folder maps to. Git knows nothing about any of that: it hands back
 * checkout roots. So every candidate carries the same offset, or a worktree
 * would go up a level too high and land beside the site instead of in it.
 */
function syncRootIn(service: FileService, checkout: string): string {
  const offset = path.relative(service.workspace, service.baseDir);
  if (offset === '' || offset.indexOf('..') === 0 || path.isAbsolute(offset)) {
    return checkout;
  }

  return path.join(checkout, offset);
}

/**
 * Every folder this connection could deploy from.
 *
 * A repository offers its checkouts - its own worktrees, and the clones of it
 * that `checkoutsOf` goes looking for, since agent tooling does not always add
 * a worktree. Anything else offers itself, which is the whole of what
 * continuous sync needs and is most connections here.
 */
async function everyCheckout(service: FileService): Promise<Worktree[]> {
  const found = await checkoutsOf(service.baseDir, whereToLook(service));
  if (found.length > 0) {
    return found;
  }

  return [
    {
      root: service.baseDir,
      isMain: true,
      exists: true,
      name: path.basename(service.baseDir),
    },
  ];
}

/** The command: which checkout should this connection deploy from? */
export async function chooseWorktree(service: FileService): Promise<void> {
  const all = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'SFTP: looking for checkouts…',
    },
    () => everyCheckout(service)
  );

  // Two kinds of checkout git reports that nobody deploys.
  //
  // One sitting on a commit rather than a branch: nothing tracks it, so there
  // is no branch to keep the server on and no git catch-up to offer. And one
  // nested inside another checkout's scratch folder: the thing deployed there
  // is the checkout around it, which is why that folder is never uploaded in
  // the first place.
  //
  // The folder this window has open is kept whatever state it is in, because
  // it is the folder this window has open.
  const showEverything = getUserSetting('sftp').get<boolean>(
    'autosync.showEveryCheckout',
    false
  );
  const found = showEverything
    ? all
    : all.filter(
        one => one.isMain || (one.branch && !nestedInScratch(one, all))
      );
  const hidden = all.length - found.length;

  const active = activeWorktree(service);

  // Newest first. The question behind the list is "which one is being worked
  // in", and the honest answer is whichever was written in last - so the time
  // is shown as well as used, because it is an indication and not a record.
  const dated = await Promise.all(
    found
      .filter(one => one.exists)
      .map(async one => {
        const syncRoot = syncRootIn(service, one.root);
        return { one, syncRoot, edited: await lastEditIn(syncRoot) };
      })
  );
  dated.sort((a, b) => (b.edited || 0) - (a.edited || 0));

  // The branch, where it is, and when it was last written in. Nothing else:
  // what the folder means is the branch name's job.
  //
  // Except when there is no branch. A checkout sitting on a commit is labelled
  // by its folder, and a folder name in the place a branch name goes reads as
  // a branch - `v17-base` looks exactly like one. So it says so, because the
  // difference is real: nothing tracks a detached checkout, so there is no
  // "keep the server on this branch" to be had and no git catch-up either.
  const items = dated.map(({ one, syncRoot, edited }) => ({
    label: one.branch || one.name,
    description:
      (active && samePath(active.root, syncRoot) ? 'syncing now · ' : '') +
      (one.branch ? '' : 'detached · ') +
      (edited ? `edited ${describeAge(edited)}` : 'no files seen'),
    detail: syncRoot,
    worktree: one as Worktree | undefined,
    syncRoot: syncRoot as string | undefined,
  }));

  if (active) {
    items.push({
      label: 'Stop syncing',
      description: 'upload-on-save takes over again',
      detail: '',
      worktree: undefined,
      syncRoot: undefined,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder:
      `Autosync ${connectionLabel(service.getConfig() as any)} from…` +
      (hidden > 0
        ? ` (${hidden} scratch checkout${hidden === 1 ? '' : 's'} hidden — ` +
          'sftp.autosync.showEveryCheckout)'
        : ''),
  });

  if (!picked) {
    return;
  }

  const took = await remember(
    service,
    picked.worktree
      ? { root: picked.syncRoot!, branch: picked.worktree.branch }
      : undefined
  );

  // Another window kept the connection, so there is nothing to catch up.
  if (!picked.worktree || !took) {
    return;
  }

  // A folder that is not a branch has nothing to compare against: git can say
  // what a branch changed, and about an ordinary directory it knows nothing.
  // Watching it from now is the whole of what was asked for.
  // What the window's own worktree is on is what has been going to this
  // server until now, so it is the best guess at what is there.
  const deployed = found.find(one => one.isMain);

  await offerToCatchUp(service, {
    syncRoot: picked.syncRoot!,
    checkout: picked.worktree.root,
    branch: picked.worktree.branch,
    against: deployed && deployed.branch,
  }).catch(error =>
    logger.debug(`could not work out the catch-up: ${error.message}`)
  );
}

/**
 * Noticing that the work has moved somewhere else.
 *
 * The question is not "has a worktree appeared" - that was the first version
 * of this, and it misses the case that actually happens: an agent picks up a
 * checkout that already existed, so nothing is created and nothing fires. The
 * question is "is another checkout of this project being written in more
 * recently than the one going to the server", which is the same question the
 * picker answers when you open it, asked on a timer instead.
 *
 * Only while a connection is already autosyncing, because "deploy this one
 * instead" needs something to be instead of. Only about checkouts the picker
 * would offer. And once per checkout: a decision not to switch is an answer,
 * not a thing to ask again in a minute.
 */
async function offerSomewhereBusier(service: FileService): Promise<void> {
  if (!storage) {
    return;
  }

  const chosen = activeWorktree(service);
  if (!chosen) {
    return;
  }

  const id = stableId(service as any);
  const all = await everyCheckout(service);
  const deployable = all.filter(
    one => one.exists && (one.isMain || (one.branch && !nestedInScratch(one, all)))
  );

  const dated = await Promise.all(
    deployable.map(async one => {
      const root = syncRootIn(service, one.root);
      return { one, root, edited: (await lastEditIn(root)) || 0 };
    })
  );

  const here = dated.find(each => samePath(each.root, chosen.root));
  const busiest = dated.sort((a, b) => b.edited - a.edited)[0];

  if (!busiest || samePath(busiest.root, chosen.root)) {
    return; // The server is already getting the folder being worked in.
  }

  // Newer than what is being deployed, and recent in its own right: a checkout
  // touched last week is not where the work is, however it compares to one
  // touched the week before.
  if (here && busiest.edited <= here.edited) {
    return;
  }
  if (Date.now() - busiest.edited > BUSY_WITHIN) {
    return;
  }

  const asked: { [id: string]: string[] } = storage.get(OFFERED, {});
  const already = asked[id] || [];
  if (already.indexOf(busiest.root) !== -1) {
    return;
  }

  asked[id] = already.concat(busiest.root);
  await storage.update(OFFERED, asked);

  const where = connectionLabel(service.getConfig() as any);
  const sync = 'Sync it instead';
  const answer = await vscode.window.showInformationMessage(
    `${busiest.one.branch || busiest.one.name} was edited ` +
      `${describeAge(busiest.edited)} — more recently than ` +
      `${chosen.branch || path.basename(chosen.root)}, which ${where} is ` +
      'deploying. Switch to it?',
    sync,
    'Not now'
  );

  if (answer === sync) {
    await remember(service, {
      root: busiest.root,
      branch: busiest.one.branch,
    });
  }
}

/**
 * Binds what is remembered to the connections that exist right now.
 *
 * Called twice over, and it has to be: connections are built after the
 * extension starts, and built again from scratch whenever `sftp.json` is
 * saved. Running it once at activation - which is what it used to do - meant
 * asking an empty list what was syncing, so nothing ever resumed; and holding
 * on across a config save meant uploading down a connection that had been
 * disposed.
 *
 * So it is written to be run as often as anybody likes: it starts what should
 * be running, stops what should not, and leaves alone what already is.
 */
export async function resumeAutosync(): Promise<void> {
  if (!storage) {
    return;
  }

  const services = getAllFileService();
  const byId = new Map<string, FileService>();
  services.forEach(service => byId.set(stableId(service as any), service));

  // A connection that has gone, or been rebuilt as a different object, is not
  // the one this watcher belongs to any more.
  for (const [id, running] of Array.from(live.entries())) {
    const current = byId.get(id);
    if (!current || current !== running.service) {
      stopWatching(id);
    }
  }

  for (const service of services) {
    const id = stableId(service as any);
    const chosen = activeWorktree(service);

    if (chosen && !live.has(id)) {
      // One writer per connection, across windows as well as within one. A
      // window that cannot claim it does not start - and says which one has
      // it, rather than quietly deploying alongside it.
      const taken = await claim(claimRoot, id, thisWindow, chosen.root).catch(
        () => ({ held: true } as const)
      );

      if (!taken.held) {
        const other = (taken as any).by;
        logger
          .for(connectionLabel(service.getConfig() as any))
          .info(
            `[autosync] another window is already syncing this connection from ` +
              `${other.root}; not starting here.`
          );
        continue;
      }

      startSession(service);
      sweepFor(service);

      const running = watchWorktree(service, chosen);
      live.set(id, running);

      // What was outstanding when the window closed is being sent again right
      // now. Said rather than done silently, because uploads starting on their
      // own at startup is a thing to know about.
      if (running.queue.size > 0) {
        vscode.window.showInformationMessage(
          `Resuming ${running.queue.size} file${
            running.queue.size === 1 ? '' : 's'
          } left over for ${connectionLabel(service.getConfig() as any)}.`
        );
      }
    }

  }

  await sayWhetherAnythingIsSyncing();

  // Everything showing what is syncing was asked before any connection
  // existed - the decorations are registered during activation, and the
  // connections are built after it - so it all answered "nothing" and had no
  // reason to ask again. This is the moment there is an answer.
  announcer().fire();
}

export function initWorktreeSync(context: vscode.ExtensionContext): void {
  storage = context.globalState;
  claimRoot = path.join(context.globalStoragePath, 'autosync-claims');

  context.subscriptions.push({
    dispose: () => {
      // What is still queued stays written down; the window closing is not a
      // reason to throw work away.
      Array.from(live.keys()).forEach(stopWatching);
    },
  });

  sayWhetherAnythingIsSyncing().catch(() => undefined);
}
