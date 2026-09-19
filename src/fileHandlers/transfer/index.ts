import * as path from 'path';
import { refreshRemoteExplorer } from '../shared';
import { getUserSetting, showModalWarning } from '../../host';
import logger from '../../logger';
import {
  compareLocalWithRemote,
  describeAge,
  LocalCopy,
} from '../compareLocal';
import { diff } from '../diff';
import {
  DEFAULT_EXCLUDED_EXTENSIONS,
  isInExcludedFolder,
  isScriptFile,
} from '../../core/scriptFiles';
import { connectionKeyFor, keepReplacedFor } from '../../modules/replacedFiles';
import createFileHandler, { FileHandlerContext } from '../createFileHandler';
import { transfer, sync, TransferOption, SyncOption, TransferDirection } from './transfer';

/**
 * What a download should keep before it writes.
 *
 * Nothing in the Timeline records a file this extension replaces, so this is
 * the only trace of what was there. Keyed by connection, so two servers that
 * map to the same folder do not share a history.
 */
function keepReplacedOption(context: FileHandlerContext) {
  return keepReplacedFor(connectionKeyFor(context.config as any));
}

function createTransferHandle(direction: TransferDirection) {
  return async function handle(this: FileHandlerContext, option) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const localFs = this.fileService.getLocalFileSystem();
    const { localFsPath, remoteFsPath } = this.target;
    const scheduler = this.fileService.createTransferScheduler(this.config.concurrency);
    let transferConfig;

    if (direction === TransferDirection.REMOTE_TO_LOCAL) {
      transferConfig = {
        srcFsPath: remoteFsPath,
        srcFs: remoteFs,
        targetFsPath: localFsPath,
        targetFs: localFs,
        transferOption: option,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
      };
    } else {
      transferConfig = {
        srcFsPath: localFsPath,
        srcFs: localFs,
        targetFsPath: remoteFsPath,
        targetFs: remoteFs,
        transferOption: option,
        filePerm: this.config.filePerm,
        dirPerm: this.config.dirPerm,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      };
    }
    // todo: abort at here. we should stop collect task
    await transfer(transferConfig, t => scheduler.add(t));
    await scheduler.run();
  };
}

const uploadHandle = createTransferHandle(TransferDirection.LOCAL_TO_REMOTE);
const downloadHandle = createTransferHandle(TransferDirection.REMOTE_TO_LOCAL);

export const sync2Remote = createFileHandler<SyncOption>({
  name: 'sync local ➞ remote',
  async handle(option) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const localFs = this.fileService.getLocalFileSystem();
    const { localFsPath, remoteFsPath } = this.target;
    const scheduler = this.fileService.createTransferScheduler(this.config.concurrency);
    // Attach filePerm and dirPerm to transferOption
    option.filePerm = this.config.filePerm;
    option.dirPerm = this.config.dirPerm;
    await sync(
      {
        srcFsPath: localFsPath,
        srcFs: localFs,
        targetFsPath: remoteFsPath,
        targetFs: remoteFs,
        transferOption: option,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      },
      t => scheduler.add(t)
    );
    await scheduler.run();
  },
  transformOption() {
    const config = this.config;
    const syncOption = config.syncOption || {};
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      delete: syncOption.delete,
      skipCreate: syncOption.skipCreate,
      ignoreExisting: syncOption.ignoreExisting,
      update: syncOption.update,
      // Only used when the sync is writing locally; an upload ignores it.
      keepReplaced: keepReplacedOption(this),
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, true);
  },
});

export const sync2Local = createFileHandler<SyncOption>({
  name: 'sync remote ➞ local',
  async handle(option) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const localFs = this.fileService.getLocalFileSystem();
    const { localFsPath, remoteFsPath } = this.target;
    const scheduler = this.fileService.createTransferScheduler(this.config.concurrency);
    await sync(
      {
        srcFsPath: remoteFsPath,
        srcFs: remoteFs,
        targetFsPath: localFsPath,
        targetFs: localFs,
        transferOption: option,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
      },
      t => scheduler.add(t)
    );
    await scheduler.run();
  },
  transformOption() {
    const config = this.config;
    const syncOption = config.syncOption || {};
    return {
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      delete: syncOption.delete,
      skipCreate: syncOption.skipCreate,
      ignoreExisting: syncOption.ignoreExisting,
      update: syncOption.update,
      // Only used when the sync is writing locally; an upload ignores it.
      keepReplaced: keepReplacedOption(this),
    };
  },
});

export const upload = createFileHandler<TransferOption>({
  name: 'upload',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, this.fileService);
  },
});

export const uploadFile = createFileHandler<TransferOption>({
  name: 'upload file',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, false);
  },
});

export const uploadFolder = createFileHandler<TransferOption>({
  name: 'upload folder',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, true);
  },
});

export const download = createFileHandler<TransferOption>({
  name: 'download',
  handle: downloadHandle,
  transformOption() {
    const config = this.config;
    return {
      verify: config.verifyTransfer !== false,
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      keepReplaced: keepReplacedOption(this),
    };
  },
});

type OnLocalNewer = 'ask' | 'download' | 'skip';

/**
 * Whether to go ahead with a download that would write over a local file
 * holding newer work than the server's copy.
 *
 * Only reached when the local file is actually newer, so it never interrupts
 * the ordinary case of pulling down a file someone else changed.
 */
async function confirmOverwrite(ctx: FileHandlerContext): Promise<boolean> {
  const behaviour = getUserSetting('sftp').get<OnLocalNewer>(
    'downloadWhenLocalIsNewer',
    'ask'
  );

  if (behaviour === 'download') {
    return true;
  }

  const comparison = await compareLocalWithRemote(ctx);
  if (comparison.state !== LocalCopy.Newer) {
    return true;
  }

  const name = path.basename(ctx.target.localFsPath);

  if (behaviour === 'skip') {
    logger.warn(
      `Not downloading ${name}: the local copy is newer than the one on the server.`
    );
    return false;
  }

  const answer = await showModalWarning(
    `Your local ${name} is newer than the copy on the server.`,
    `Downloading replaces it, and the changes that are only on disk are lost.\n\n${describeAge(
      comparison
    )}`,
    'Overwrite',
    'Compare'
  );

  if (answer === 'Compare') {
    await diff(ctx);
  }

  return answer === 'Overwrite';
}

export const downloadFile = createFileHandler<TransferOption>({
  name: 'download file',
  async handle(option) {
    if (!(await confirmOverwrite(this))) {
      return;
    }

    await downloadHandle.call(this, option);
  },
  transformOption() {
    const config = this.config;
    return {
      verify: config.verifyTransfer !== false,
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      keepReplaced: keepReplacedOption(this),
    };
  },
});

export const downloadFolder = createFileHandler<TransferOption>({
  name: 'download folder',
  handle: downloadHandle,
  transformOption() {
    const config = this.config;
    return {
      verify: config.verifyTransfer !== false,
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      keepReplaced: keepReplacedOption(this),
    };
  },
});

export const downloadScripts = createFileHandler<TransferOption>({
  name: 'download scripts',
  handle: downloadHandle,
  transformOption() {
    const config = this.config;
    const settings = getUserSetting('sftp');

    // An unset setting comes back as its own declared default, an empty
    // array, which would exclude nothing at all.
    const listOr = (section: string, fallback: string[]) => {
      const configured = settings.get<string[]>(section);
      return configured && configured.length > 0 ? configured : fallback;
    };

    const excludedExtensions = listOr(
      'downloadScripts.excludeExtensions',
      DEFAULT_EXCLUDED_EXTENSIONS
    );
    // No folders are skipped unless the setting names some.
    const excludedFolders =
      settings.get<string[]>('downloadScripts.excludeFolders') || [];
    const root = this.target.remoteFsPath;

    return {
      verify: config.verifyTransfer !== false,
      perserveTargetMode: false,
      ignore:
        excludedFolders.length === 0
          ? config.ignore
          : (fsPath: string) =>
              Boolean(config.ignore && config.ignore(fsPath)) ||
              isInExcludedFolder(fsPath, excludedFolders, root),
      // File-level, so a folder with a dot in its name is not mistaken for one.
      fileFilter: (fsPath: string) => isScriptFile(fsPath, excludedExtensions),
      keepReplaced: keepReplacedOption(this),
    };
  },
});
