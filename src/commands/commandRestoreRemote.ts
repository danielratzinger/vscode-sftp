import * as vscode from 'vscode';
import * as path from 'path';
import { COMMAND_RESTORE_REMOTE } from '../constants';
import { showInformationMessage, showModalWarning, showWarningMessage } from '../host';
import logger, { withConnection } from '../logger';
import connectionLabel from '../core/connectionLabel';
import { describeAge } from '../mcp/localHistory';
import { uploadMany } from '../fileHandlers/uploadMany';
import { removeRemote } from '../fileHandlers';
import { resourceFor } from '../fileHandlers/createFileHandler';
import isNotFound from '../core/notFound';
import { UResource } from '../core';
import {
  isEnabled,
  sessionsFor,
  whatToRestore,
} from '../modules/autosyncBackup';
import { whichConnection } from './commandAutosyncWorktree';
import { checkCommand } from './abstract/createCommand';

/**
 * Putting a server back to how it was before a run of autosync.
 *
 * Continuous deploy is the case where nobody is watching each upload, so the
 * moment a bad one is noticed it has usually been on the server for a while
 * and the only copy of what was there is underneath it. This is the way back:
 * pick a session, and every file that session or a later one wrote over goes
 * back to what it was before the first of them touched it.
 *
 * The count is shown before anything moves, and files that were not on the
 * server at all are named separately, because putting *those* back means
 * removing them - which is the one destructive part of a restore and is not
 * something to do quietly.
 */
export default checkCommand({
  id: COMMAND_RESTORE_REMOTE,

  async handleCommand(...args: any[]) {
    if (!isEnabled()) {
      showInformationMessage(
        'Keeping the server’s copies is turned off (sftp.autosync.backupRemote).'
      );
      return;
    }

    const service = await whichConnection(...args);
    if (!service) {
      return;
    }

    const where = connectionLabel(service.getConfig() as any);
    const sessions = await sessionsFor(service);

    if (sessions.length === 0) {
      showInformationMessage(
        `Nothing kept for ${where} yet. Copies are made when autosync is about ` +
          'to write over a file the server already has.'
      );
      return;
    }

    const chosen = await vscode.window.showQuickPick(
      sessions.map(session => ({
        label: new Date(session.when).toLocaleString(),
        description: `${session.files} file${session.files === 1 ? '' : 's'} · ${describeAge(
          session.when
        )}`,
        detail: 'Undo everything from this point onwards',
        stamp: session.stamp,
      })),
      { placeHolder: `Put ${where} back to…` }
    );

    if (!chosen) {
      return;
    }

    const restorable = await whatToRestore(service, chosen.stamp);
    const toUpload = restorable.filter(one => one.from);
    const toRemove = restorable.filter(one => !one.from);

    if (restorable.length === 0) {
      showInformationMessage(`Nothing to put back on ${where}.`);
      return;
    }

    const removing = toRemove.length
      ? ` ${toRemove.length} file${toRemove.length === 1 ? ' was' : 's were'} not ` +
        'on the server then and will be removed.'
      : '';

    const go = `Restore ${toUpload.length}`;
    const answer = await showModalWarning(
      `Put ${toUpload.length} file${toUpload.length === 1 ? '' : 's'} on ${where} ` +
        `back to ${chosen.label}?`,
      removing.trim() ||
        'Every file is copied off the server before it is written over.',
      go
    );

    if (answer !== go) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Putting ${where} back to ${chosen.label}`,
        cancellable: true,
      },
      (progress, token) => withConnection(where, async () => {
        let done = 0;

        const result = await uploadMany(
          service,
          toUpload.map(one => ({ local: one.from!, remote: one.remotePath })),
          {
            // One thing said at the end; the transfer log still has every file.
            announce: false,
            cancelled: () => token.isCancellationRequested,
            onDone: (upload) => {
              done += 1;
              progress.report({
                increment: 100 / toUpload.length,
                message: `${done} of ${toUpload.length}: ${path.basename(
                  upload.remote
                )}`,
              });
            },
          }
        );

        let removed = 0;
        const notRemoved: string[] = [];
        for (const one of toRemove) {
          if (token.isCancellationRequested) {
            break;
          }

          // A whole target, both sides of it. The remover reads the server's
          // path off `remoteFsPath`, which only a `UResource` has; handed the
          // bare remote resource it read `undefined`, and every file a restore
          // should have taken away stayed.
          const config = service.getConfig() as any;
          const remoteUri = UResource.makeResource({
            remote: { host: config.host, port: config.port },
            fsPath: one.remotePath,
            remoteId: service.id,
          }).uri;

          try {
            await removeRemote({
              fileService: service,
              config,
              target: resourceFor(service, config, remoteUri),
            });
            removed += 1;
          } catch (error) {
            // Not there is what a removal wants.
            if (isNotFound(error)) {
              removed += 1;
              continue;
            }
            notRemoved.push(one.remotePath);
            logger.error(error, `restore remove ${one.remotePath}`);
          }
        }

        const failures = result.failed.length + notRemoved.length;
        const trouble =
          (result.failed.length ? `, ${result.failed.length} could not be written` : '') +
          (notRemoved.length ? `, ${notRemoved.length} could not be removed` : '');

        logger
          .for(where)
          .info(
            `[restore] ${result.uploaded.length} put back${
              removed ? `, ${removed} removed` : ''
            }${trouble}.`
          );

        if (failures) {
          // A restore that left files behind is not a restore that worked,
          // however many others it put back.
          showWarningMessage(
            `${failures} file${failures === 1 ? '' : 's'} could not be put back ` +
              'as they were. The output panel says which.'
          );
        } else {
          showInformationMessage(
            `${where} is back to ${chosen.label}: ${result.uploaded.length} ` +
              `restored${removed ? `, ${removed} removed` : ''}.`
          );
        }
      })
    );
  },
});
