import * as path from 'path';
import * as fse from 'fs-extra';
import * as vscode from 'vscode';
import logger from '../logger';
import { fileOperations, FileType, upath } from '../core';
import connectionLabel from '../core/connectionLabel';
import { Candidate, findIgnored, ignoreRulesFor, IgnoreRules } from '../core/projectIgnore';
import { FileHandlerContext } from '../fileHandlers/createFileHandler';
import { refreshRemoteExplorer } from '../fileHandlers/shared';
import { clearToOverwrite } from './autosyncBackup';

/**
 * Two ways of finding what is on the server and should perhaps not be, and
 * one way of taking it off: a list with a box beside each, and nothing
 * removed that was not ticked.
 *
 * `Remove all ignored files from remote` looks for what the project's ignore
 * files, and the connection's own `ignore`, say should never have been sent.
 * Those start ticked: they were named as not belonging there.
 *
 * `Tidy Remote` looks for what the server has and this machine does not.
 * Those start unticked: a server keeps uploads, caches and its own `.env`,
 * which no checkout has and which the site cannot do without.
 *
 * A folder found either way is listed once and not looked inside.
 */

export interface Found {
  remotePath: string;
  /** Relative to the folder looked in, as the list shows it. */
  label: string;
  dir: boolean;
}

interface Walk {
  context: FileHandlerContext;
  progress: vscode.Progress<{ message?: string }>;
  token: vscode.CancellationToken;
}

/** Where a path on this machine is on the server, below the folder looked in. */
function remoteOf(context: FileHandlerContext, local: string): string {
  const { localFsPath, remoteFsPath } = context.target;
  const relative = path.relative(localFsPath, local);
  return relative === ''
    ? remoteFsPath
    : upath.join(remoteFsPath, ...relative.split(path.sep));
}

function labelOf(context: FileHandlerContext, local: string, dir: boolean): string {
  const relative = path.relative(context.target.localFsPath, local).split(path.sep).join('/');
  return `${relative}${dir ? '/' : ''}`;
}

/** What is in a folder on the server, named by where it would be here. */
async function listRemote(walk: Walk, local: string): Promise<Candidate[]> {
  if (walk.token.isCancellationRequested) {
    return [];
  }

  const remote = remoteOf(walk.context, local);
  walk.progress.report({ message: remote });

  const remoteFs = await walk.context.fileService.getRemoteFileSystem(walk.context.config);
  try {
    const entries = await remoteFs.list(remote);
    return entries.map(entry => ({
      path: path.join(local, entry.name),
      dir: entry.type === FileType.Directory,
    }));
  } catch (error) {
    // One folder that cannot be read is not the whole answer failing.
    logger.warn(`could not list ${remote}: ${error.message}`);
    return [];
  }
}

/** The project's rules with the connection's own `ignore` added to them. */
function withConnectionIgnore(
  rules: IgnoreRules | undefined,
  ignore: ((fsPath: string) => boolean) | null | undefined
): IgnoreRules | undefined {
  if (!ignore) {
    return rules;
  }

  return {
    sources: (rules ? rules.sources : []).concat('sftp.json'),
    async ignoredAmong(candidates) {
      const ignored = rules ? await rules.ignoredAmong(candidates) : new Set<string>();
      candidates.forEach(one => {
        if (ignore(one.path)) {
          ignored.add(one.path);
        }
      });
      return ignored;
    },
  };
}

/** Whether there is anything to look for: rules of the project's, or the connection's. */
export async function rulesOf(context: FileHandlerContext): Promise<IgnoreRules | undefined> {
  return withConnectionIgnore(
    await ignoreRulesFor(context.fileService.baseDir),
    context.fileService.getConfig().ignore
  );
}

export async function ignoredOnRemote(
  walk: Walk,
  rules: IgnoreRules
): Promise<Found[]> {
  const found = await findIgnored(rules, walk.context.target.localFsPath, local =>
    listRemote(walk, local)
  );

  return found.map(one => ({
    remotePath: remoteOf(walk.context, one.path),
    label: labelOf(walk.context, one.path, one.dir),
    dir: one.dir,
  }));
}

export async function missingLocally(walk: Walk): Promise<Found[]> {
  const found: Found[] = [];
  let level = [walk.context.target.localFsPath];

  while (level.length > 0 && !walk.token.isCancellationRequested) {
    const next: string[] = [];
    for (const folder of level) {
      for (const one of await listRemote(walk, folder)) {
        const here = await fse.lstat(one.path).catch(() => undefined);
        if (!here) {
          found.push({
            remotePath: remoteOf(walk.context, one.path),
            label: labelOf(walk.context, one.path, one.dir),
            dir: one.dir,
          });
        } else if (one.dir && here.isDirectory()) {
          next.push(one.path);
        }
      }
    }
    level = next;
  }

  return found;
}

/** Looks, with something on screen while it does, and can be called off. */
export function looking<T>(
  context: FileHandlerContext,
  title: string,
  look: (walk: Walk) => Promise<T>
): Thenable<T | undefined> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      const result = await look({ context, progress, token });
      return token.isCancellationRequested ? undefined : result;
    }
  );
}

/**
 * The list, and the removal of whatever is left ticked.
 *
 * Every file is copied off the server first, into the history `Restore
 * Server to an Earlier Point` reads, and a file that cannot be copied is left
 * where it is - the rule autosync keeps. A folder has no copy taken; the list
 * says so before anything goes.
 */
export async function pickAndRemove(
  context: FileHandlerContext,
  found: Found[],
  option: { title: string; ticked: boolean }
): Promise<void> {
  const where = connectionLabel(context.config as any);
  const items = found
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(one => ({
      label: one.label,
      description: one.dir ? 'folder, removed with everything in it and no copy' : '',
      picked: option.ticked,
      found: one,
    }));

  const chosen = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    ignoreFocusOut: true,
    title: `${option.title} - ${where}`,
    placeHolder: 'What is ticked is deleted from the server on OK. Files are copied off first.',
  });

  if (!chosen || chosen.length === 0) {
    return;
  }

  const remoteFs = await context.fileService.getRemoteFileSystem(context.config);
  let removed = 0;
  let kept = 0;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Deleting from ${where}`,
      cancellable: true,
    },
    async (progress, token) => {
      for (const { found: one } of chosen) {
        if (token.isCancellationRequested) {
          break;
        }
        progress.report({ message: one.label, increment: 100 / chosen.length });

        if (!one.dir) {
          const cleared = await clearToOverwrite(context.fileService, one.remotePath).catch(
            () => false
          );
          if (!cleared) {
            kept += 1;
            continue;
          }
        }

        try {
          if (one.dir) {
            await fileOperations.removeDir(one.remotePath, remoteFs, {});
          } else {
            await fileOperations.removeFile(one.remotePath, remoteFs, {});
          }
          removed += 1;
          logger.info(`[cleanup] removed ${one.remotePath}`);
        } catch (error) {
          logger.warn(`could not remove ${one.remotePath}: ${error.message}`);
          kept += 1;
        }
      }
    }
  );

  refreshRemoteExplorer(context.target, true);
  vscode.window.showInformationMessage(
    `${removed} removed from ${where}` +
      (kept ? `; ${kept} left there (no copy could be kept, or it could not be removed).` : '.')
  );
}
