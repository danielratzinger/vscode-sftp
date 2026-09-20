import { FileService } from '../core';
import TransferTask from '../core/transferTask';
import { transfer, TransferDirection } from './transfer/transfer';

/**
 * A list of files uploaded the way the extension uploads anything.
 *
 * Not a second transfer path: the same `transfer()` that builds a task for a
 * save, added to one of the connection's own schedulers, so `concurrency`,
 * `verifyTransfer`, `useTempFile`, the per-task retries and the progress the
 * status bar shows all work here exactly as they do everywhere else. The only
 * thing this adds is the shape - a set of files rather than a folder - which
 * is what a catch-up is.
 *
 * One scheduler for the batch rather than one per file, which is the whole
 * point: a fresh deploy of a thousand files is a thousand transfers over the
 * connection that is already open, not a thousand connections.
 */

export interface Upload {
  /** Where the file is on this machine. */
  local: string;
  /** Where it goes on the server. */
  remote: string;
}

export interface ManyResult {
  uploaded: string[];
  failed: Array<{ local: string; error: Error }>;
}

export interface ManyOption {
  /** Called as each file finishes, for progress. */
  onDone?(upload: Upload, error?: Error): void;
  /** Asked before each file is queued; false leaves it out. */
  allow?(upload: Upload): Promise<boolean>;
  cancelled?(): boolean;
  /**
   * Whether a failed file should raise a dialog of its own.
   *
   * On by default, as it is for every other transfer. Off for callers that
   * report the batch themselves - a queue that retries cannot ask a question
   * per attempt, and fifty failures in a catch-up is one thing to say, not
   * fifty.
   */
  announce?: boolean;
}

export async function uploadMany(
  service: FileService,
  files: Upload[],
  option: ManyOption = {}
): Promise<ManyResult> {
  const config = service.getConfig();
  const remoteFs = await service.getRemoteFileSystem(config);
  const localFs = service.getLocalFileSystem();
  const scheduler = service.createTransferScheduler((config as any).concurrency);

  const result: ManyResult = { uploaded: [], failed: [] };

  const transferOption = {
    verify: (config as any).verifyTransfer !== false,
    perserveTargetMode:
      config.protocol === 'sftp' && !(config as any).filePerm,
    useTempFile: (config as any).useTempFile,
    openSsh: (config as any).openSsh,
    ignore: config.ignore,
  };

  for (const file of files) {
    if (option.cancelled && option.cancelled()) {
      break;
    }

    if (option.allow && !(await option.allow(file))) {
      continue;
    }

    await transfer(
      {
        srcFsPath: file.local,
        srcFs: localFs,
        targetFsPath: file.remote,
        targetFs: remoteFs,
        transferOption,
        filePerm: (config as any).filePerm,
        dirPerm: (config as any).dirPerm,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      } as any,
      (task: TransferTask) => {
        // One file failing is not the batch failing, and the caller needs to
        // know which one failed. The scheduler reports only that a task
        // finished, so the outcome is noted where it happens - around the
        // task's own run.
        //
        // And then re-thrown, every time. The scheduler catches it, carries on
        // with the rest, and hands it to the connection's `afterTransfer`,
        // which is what writes `local ➞ remote <path>` to the output panel and
        // moves the status bar. Swallowing it here would leave a failed upload
        // logged as a completed one, which is worse than not logging it at all.
        const run = task.run.bind(task);
        (task as any).run = async () => {
          if (option.cancelled && option.cancelled()) {
            return undefined;
          }

          try {
            const done = await run();
            result.uploaded.push(file.local);
            if (option.onDone) {
              option.onDone(file);
            }
            return done;
          } catch (error) {
            result.failed.push({ local: file.local, error });
            if (option.onDone) {
              option.onDone(file, error);
            }

            if (option.announce === false) {
              // The convention the transfer listener reads: written down, not
              // raised.
              (error as any).reported = true;
            }

            throw error;
          }
        };

        scheduler.add(task);
      }
    ).catch(error => {
      // The file could not even be read to build a task for it.
      result.failed.push({ local: file.local, error });
      if (option.onDone) {
        option.onDone(file, error);
      }
    });
  }

  await scheduler.run();

  return result;
}
