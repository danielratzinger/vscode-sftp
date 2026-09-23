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
  localSize?: number;
  remoteSize?: number;
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
    localSize: local.size,
    remoteSize: remote.size,
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

/**
 * Whether a download is worth stopping to ask about, before the bytes are
 * looked at.
 *
 * Ordinarily only when ours is newer: pulling down a file someone else changed
 * is what a download is for. While the server is being fed from another folder
 * the timestamps say nothing - this folder and that one were written at
 * different moments whatever is in them - so any difference is worth asking
 * about, whichever side is newer.
 */
export function worthAsking(state: LocalCopy, syncedElsewhere: boolean): boolean {
  if (state === LocalCopy.Missing || state === LocalCopy.Same) {
    return false;
  }

  return syncedElsewhere || state === LocalCopy.Newer;
}

/**
 * Whether the two copies hold the same bytes.
 *
 * Asked only where timestamps cannot answer it. Different sizes settle it
 * without reading anything.
 */
export async function sameContent(
  ctx: FileHandlerContext,
  comparison: Comparison
): Promise<boolean> {
  if (comparison.localSize !== comparison.remoteSize) {
    return false;
  }

  const remoteFs = await ctx.fileService.getRemoteFileSystem(ctx.config);
  const [local, remote] = await Promise.all([
    localFs.readFile(ctx.target.localFsPath),
    remoteFs.readFile(ctx.target.remoteFsPath),
  ]);

  return toBuffer(local).equals(toBuffer(remote));
}

function toBuffer(content: string | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

export function describeAge(comparison: Comparison): string {
  if (comparison.localMtime === undefined || comparison.remoteMtime === undefined) {
    return '';
  }

  const local = new Date(comparison.localMtime).toLocaleString();
  const remote = new Date(comparison.remoteMtime).toLocaleString();

  return `Local: ${local}\nRemote: ${remote}`;
}
