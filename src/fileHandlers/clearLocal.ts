import * as fse from 'fs-extra';
import { Uri, workspace } from 'vscode';
import createFileHandler from './createFileHandler';
import {
  Clearance,
  ClearOption,
  isWithin,
  planClearance,
} from '../core/clearLocal';
import { showConfirmMessage } from '../host';
import { simplifyPath } from '../helper';
import logger from '../logger';

/**
 * Emptying the local copy of a folder.
 *
 * `Download Scripts` writes files and never removes them, so a folder that has
 * been downloaded across a year of deploys holds files the server deleted
 * months ago - and nothing downstream can tell those apart from current ones.
 * This is the other half of that: clear the folder, download it again, and
 * what is on disk is what is on the server.
 *
 * It deletes from this machine and never from the server. What it removes goes
 * to the system's trash where that is possible, because "download it again" is
 * a poor answer to a folder that turns out to have held something else.
 */

function describeSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describePlan(local: string, plan: Clearance, root: boolean): string {
  const what =
    `${plan.files} file${plan.files === 1 ? '' : 's'} (${describeSize(plan.bytes)})`;

  return (
    `Delete ${what} from ${simplifyPath(local)}?` +
    (root ? '\nThis is the whole local copy of this connection.' : '') +
    (plan.kept
      ? `\n${plan.kept} kept back — ${plan.keptFor}.`
      : '') +
    '\nThe server is not touched. Files go to the trash where the system ' +
    'supports it.'
  );
}

async function remove(target: string): Promise<void> {
  const uri = Uri.file(target);

  try {
    await workspace.fs.delete(uri, { recursive: true, useTrash: true });
  } catch (error) {
    // Not every filesystem has a trash - a network mount, a container, a
    // volume with none configured. Asked to clear the folder, so clear it.
    logger.debug(`could not trash ${target}, removing it: ${error.message}`);
    await fse.remove(target);
  }
}

export const clearLocalFolder = createFileHandler<ClearOption>({
  name: 'clear local folder',
  async handle(option) {
    const local = this.target.localFsPath;
    const root = this.fileService.baseDir;

    // The same boundary every other path in this extension is held to: a
    // remote path resolves to somewhere below the folder this connection
    // manages, or it does not resolve at all.
    if (!isWithin(root, local)) {
      logger.warn(`[clear] ${local} is outside ${root}; nothing was removed.`);
      return;
    }

    let stat;
    try {
      stat = await fse.stat(local);
    } catch (error) {
      logger.info(`[clear] there is no local copy of this folder (${local}).`);
      return;
    }

    if (!stat.isDirectory()) {
      logger.warn(`[clear] ${local} is a file, not a folder.`);
      return;
    }

    const plan = await planClearance(local, option);
    if (plan.paths.length === 0) {
      logger.info(`[clear] ${local} is already empty.`);
      return;
    }

    const confirmed = await showConfirmMessage(
      describePlan(local, plan, isWithin(local, root)),
      'Delete',
      'Cancel'
    );

    if (!confirmed) {
      logger.info(`[clear] cancelled; nothing was removed from ${local}.`);
      return;
    }

    let removed = 0;
    for (const target of plan.paths) {
      try {
        await remove(target);
        removed += 1;
      } catch (error) {
        logger.error(error, `clear ${target}`);
      }
    }

    logger.info(
      `[clear] removed ${plan.files} file${plan.files === 1 ? '' : 's'} ` +
        `(${describeSize(plan.bytes)}) from ${local}` +
        (removed < plan.paths.length
          ? `; ${plan.paths.length - removed} could not be removed`
          : '') +
        (plan.kept ? `, keeping ${plan.kept}` : '') +
        '.'
    );
  },
  transformOption() {
    return { ignore: this.config.ignore || undefined };
  },
});
