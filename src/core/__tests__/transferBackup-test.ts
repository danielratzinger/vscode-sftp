import TransferTask from '../transferTask';
import { TransferDirection } from '../transferTask';
import { FileType } from '../fs';

/**
 * The hook itself, at the one moment that matters: after this, the bytes are
 * gone.
 */
function task(direction: TransferDirection, option: any) {
  const fs: any = {
    get: async () => ({ on: () => undefined, pipe: () => undefined }),
    put: async () => undefined,
    lstat: async () => ({ type: FileType.File, size: 1, mtime: 1 }),
    size: async () => 1,
    supportsDirectTransfer: () => false,
  };

  return new TransferTask(
    { fsPath: '/srv/app/index.php', fileSystem: fs },
    { fsPath: '/work/site/index.php', fileSystem: fs },
    {
      fileType: FileType.File,
      transferDirection: direction,
      transferOption: option,
    }
  );
}

describe('keeping what a transfer replaces', () => {
  it('asks once, before the first attempt', async () => {
    const asked: any[] = [];
    const transfer = task(TransferDirection.REMOTE_TO_LOCAL, {
      atime: 0,
      mtime: 2000,
      size: 42,
      perserveTargetMode: false,
      keepReplaced: async (localPath: string, incoming: any) => {
        asked.push([localPath, incoming]);
      },
    });

    // The transfer itself fails on the stub filesystem; what matters is that
    // the copy was taken first.
    await (transfer as any)._transferFileWithRetry().catch(() => undefined);

    expect(asked).toEqual([['/work/site/index.php', { size: 42, mtime: 2000 }]]);
  });

  it('never asks on an upload', async () => {
    // The same code uploads, and keeping the remote file would mean fetching
    // it first: a transfer for every transfer.
    const asked: string[] = [];
    const transfer = task(TransferDirection.LOCAL_TO_REMOTE, {
      atime: 0,
      mtime: 2000,
      perserveTargetMode: false,
      keepReplaced: async (localPath: string) => {
        asked.push(localPath);
      },
    });

    await (transfer as any)._transferFileWithRetry().catch(() => undefined);

    expect(asked).toEqual([]);
  });

  it('goes ahead with the download when the copy cannot be kept', async () => {
    // A safety net is not the floor: failing to keep a copy must not stop the
    // transfer the user asked for.
    const transfer = task(TransferDirection.REMOTE_TO_LOCAL, {
      atime: 0,
      mtime: 2000,
      perserveTargetMode: false,
      keepReplaced: async () => {
        throw new Error('the disk is full');
      },
    });

    const error = await (transfer as any)
      ._transferFileWithRetry()
      .then(() => undefined, (e: Error) => e);

    expect(error && error.message).not.toContain('disk is full');
  });
});
