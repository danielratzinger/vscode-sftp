import * as os from 'os';
import * as path from 'path';
import * as fse from 'fs-extra';
import { Uri } from 'vscode';
import { refreshRemoteExplorer } from '../shared';
import { getUserSetting, showModalWarning, showTextDocument } from '../../host';
import { fileOperations } from '../../core';
import { autosyncState, AutosyncState } from '../../modules/worktreeSync';
import { trackRemoteCopy } from '../../modules/remoteEdits';
import logger from '../../logger';
import {
  compareLocalWithRemote,
  describeAge,
  LocalCopy,
  sameContent,
  worthAsking,
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
      verify: config.verifyTransfer !== false,
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
      verify: config.verifyTransfer !== false,
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
      verify: config.verifyTransfer !== false,
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
      verify: config.verifyTransfer !== false,
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
      verify: config.verifyTransfer !== false,
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

const OVERWRITE = 'Overwrite';
const COMPARE = 'Compare';
const OPEN_LOCAL = 'Open Local';
const OPEN_REMOTE = 'Open Remote';

/**
 * What came of asking: go ahead, leave it, or something was opened in its
 * place - which a caller about to open the local file must not bury.
 */
type Decision = 'download' | 'declined' | 'shown';

/**
 * Whether to go ahead with a download that would write over a local file
 * holding something the server's copy does not.
 *
 * Ordinarily only reached when the local file is newer, so it never interrupts
 * the ordinary case of pulling down a file someone else changed. While the
 * connection is being autosynced from another folder, any difference is asked
 * about: the server then holds that folder's work, not an older version of
 * this one, and which side was written last says nothing about which is right.
 */
async function confirmOverwrite(ctx: FileHandlerContext): Promise<Decision> {
  const behaviour = getUserSetting('sftp').get<OnLocalNewer>(
    'downloadWhenLocalIsNewer',
    'ask'
  );
  const elsewhere = syncedFrom(ctx);

  if (behaviour === 'download' && !elsewhere) {
    return 'download';
  }

  const comparison = await compareLocalWithRemote(ctx);
  if (!worthAsking(comparison.state, Boolean(elsewhere))) {
    return 'download';
  }

  // The timestamps of two folders say nothing about whether they differ.
  if (elsewhere && (await sameContent(ctx, comparison).catch(() => false))) {
    return 'download';
  }

  const name = path.basename(ctx.target.localFsPath);
  const newer = comparison.state === LocalCopy.Newer;

  if (behaviour === 'skip' && newer) {
    logger.warn(
      `Not downloading ${name}: the local copy is newer than the one on the server.`
    );
    return 'declined';
  }

  const age = describeAge(comparison);
  const answer = await showModalWarning(
    newer
      ? `Your local ${name} is newer than the copy on the server.`
      : `Your local ${name} differs from the copy on the server.`,
    (elsewhere
      ? `The server is being autosynced from ${elsewhere.label} (${elsewhere.root}), ` +
        'so its copy is that folder\'s work, not this one\'s. '
      : '') +
      `Downloading replaces your local copy, and the changes that are only on disk are lost.` +
      (age ? `\n\n${age}` : ''),
    OVERWRITE,
    COMPARE,
    OPEN_LOCAL,
    OPEN_REMOTE
  );

  switch (answer) {
    case OVERWRITE:
      return 'download';
    case COMPARE:
      await diff(ctx);
      return 'shown';
    case OPEN_LOCAL:
      await showTextDocument(Uri.file(ctx.target.localFsPath));
      return 'shown';
    case OPEN_REMOTE:
      await openRemoteCopy(ctx);
      return 'shown';
    default:
      return 'declined';
  }
}

/** The folder this connection is autosynced from, when it is not this one. */
function syncedFrom(ctx: FileHandlerContext): AutosyncState | undefined {
  const state = autosyncState(ctx.fileService);
  return state && state.external ? state : undefined;
}

/**
 * The server's copy, opened as a file of its own.
 *
 * Downloaded to a folder of its own under the system's temp directory, not
 * next to the local file, so it can be edited and saved like any other file
 * without writing over the local one - that is what Overwrite is for. No
 * connection covers the temp directory, so where it came from is written down
 * and a save offers to send it back there. Named
 * as it is on the server, inside a folder named after the connection, so the
 * tab and breadcrumbs say which copy it is. A fresh folder each time, so
 * opening it again never writes over edits made to the last one.
 */
async function openRemoteCopy(ctx: FileHandlerContext): Promise<void> {
  const remoteFs = await ctx.fileService.getRemoteFileSystem(ctx.config);
  const localFs = ctx.fileService.getLocalFileSystem();
  const connection = (ctx.fileService.name || ctx.config.host || 'remote').replace(
    /[\\/:*?"<>|]/g,
    '_'
  );
  const folder = path.join(
    await fse.mkdtemp(path.join(os.tmpdir(), 'sftp-remote-')),
    connection
  );
  const copy = path.join(folder, path.basename(ctx.target.remoteFsPath));

  await fse.ensureDir(folder);
  await fileOperations.transferFile(ctx.target.remoteFsPath, copy, remoteFs, localFs);
  trackRemoteCopy(copy, {
    service: ctx.fileService,
    remotePath: ctx.target.remoteFsPath,
  });
  await showTextDocument(Uri.file(copy));
}

function downloadFileOption(this: FileHandlerContext) {
  const config = this.config;
  return {
    verify: config.verifyTransfer !== false,
    perserveTargetMode: false,
    // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
    ignore: config.ignore,
    keepReplaced: keepReplacedOption(this),
  };
}

export const downloadFile = createFileHandler<TransferOption>({
  name: 'download file',
  async handle(option) {
    if ((await confirmOverwrite(this)) !== 'download') {
      return;
    }

    await downloadHandle.call(this, option);
  },
  transformOption: downloadFileOption,
});

/**
 * A file opened from the remote explorer: brought down, then opened.
 *
 * Opened only when the question did not already open something in its place -
 * `Open Remote` followed by the local file would put the one asked for behind
 * the one that was not. A download that was declined still opens the local
 * file, as it always did.
 */
export const editInLocal = createFileHandler<TransferOption>({
  name: 'edit in local',
  async handle(option) {
    const decision = await confirmOverwrite(this);
    if (decision === 'shown') {
      return;
    }

    if (decision === 'download') {
      await downloadHandle.call(this, option);
    }

    await showTextDocument(this.target.localUri, { preview: true });
  },
  transformOption: downloadFileOption,
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
