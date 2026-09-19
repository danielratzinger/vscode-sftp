import { FileHandlerContext } from './createFileHandler';
import localFs from '../core/localFs';

export enum LocalCopy {
  /** Nothing on disk yet. */
  Missing = 'missing',
  /** Same timestamp and size: downloading would change nothing. */
  Same = 'same',
  /** The server's copy is newer, which is the ordinary reason to download. */
  Older = 'older',
  /** Ours is newer. Downloading would write over work that isn't on the server. */
  Newer = 'newer',
}

export interface Comparison {
  state: LocalCopy;
  localMtime?: number;
  remoteMtime?: number;
}

/**
 * Timestamps are compared at second granularity, the same as the sync
 * algorithm: a lot of servers only report whole seconds, and a transfer
 * copies the source's mtime onto the target, so an untouched local copy
 * matches its remote exactly.
 */
function toSeconds(mtime: number): number {
  return Math.floor(mtime / 1000);
}

/**
 * How the file on disk stands against the one on the server, before deciding
 * whether to write over it.
 */
export async function compareLocalWithRemote(
  ctx: FileHandlerContext
): Promise<Comparison> {
  const local = await localFs
    .lstat(ctx.target.localFsPath)
    .catch(() => undefined);

  if (!local) {
    return { state: LocalCopy.Missing };
  }

  const remoteFs = await ctx.fileService.getRemoteFileSystem(ctx.config);
  const remote = await remoteFs
    .lstat(ctx.target.remoteFsPath)
    .catch(() => undefined);

  // Nothing to compare against, so nothing to warn about; let the download
  // itself report a missing file.
  if (!remote) {
    return { state: LocalCopy.Missing };
  }

  const localSeconds = toSeconds(local.mtime);
  const remoteSeconds = toSeconds(remote.mtime);
  const comparison = {
    localMtime: local.mtime,
    remoteMtime: remote.mtime,
  };

  if (localSeconds === remoteSeconds) {
    return {
      ...comparison,
      state: local.size === remote.size ? LocalCopy.Same : LocalCopy.Newer,
    };
  }

  return {
    ...comparison,
    state: localSeconds > remoteSeconds ? LocalCopy.Newer : LocalCopy.Older,
  };
}

export function describeAge(comparison: Comparison): string {
  if (comparison.localMtime === undefined || comparison.remoteMtime === undefined) {
    return '';
  }

  const local = new Date(comparison.localMtime).toLocaleString();
  const remote = new Date(comparison.remoteMtime).toLocaleString();

  return `Local: ${local}\nRemote: ${remote}`;
}
