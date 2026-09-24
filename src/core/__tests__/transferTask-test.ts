import { Readable } from 'stream';
import TransferTask, {
  TransferDirection,
  TransferIntegrityError,
} from '../transferTask';
import { FileType, LocalFileSystem } from '../fs';

const CONTENT_SIZE = 12;

function readableOf(content: string): Readable {
  const stream = new Readable();
  stream.push(content);
  stream.push(null);
  return stream;
}

interface FakeOption {
  size?: number | undefined;
  putError?: Error;
  directError?: Error;
}

/**
 * A remote file system that records what was asked of it. `direct: true` adds
 * the pipelined transfer methods, which is what makes TransferTask take the
 * direct route.
 */
function createRemoteFs(direct: boolean, option: FakeOption = {}) {
  const calls: string[] = [];
  const written = new Map<string, number>();

  const base: any = {
    pathResolver: { join: (...parts: string[]) => parts.join('/') },
    calls,
    written,
    open: (path: string) => {
      calls.push(`open ${path}`);
      return Promise.resolve({ path });
    },
    close: () => Promise.resolve(),
    fstat: () => Promise.resolve({ mode: 0o644 }),
    lstat: (path: string) => {
      calls.push(`lstat ${path}`);
      return Promise.reject(new Error('not found'));
    },
    futimes: () => Promise.resolve(),
    utimes: (path: string) => {
      calls.push(`utimes ${path}`);
      return Promise.resolve();
    },
    put: (_input: Readable, path: string) => {
      calls.push(`put ${path}`);
      if (option.putError) {
        return Promise.reject(option.putError);
      }
      written.set(path, CONTENT_SIZE);
      return Promise.resolve();
    },
    get: (path: string) => {
      calls.push(`get ${path}`);
      return Promise.resolve(readableOf('x'.repeat(CONTENT_SIZE)));
    },
    size: (path: string) => {
      calls.push(`size ${path}`);
      return Promise.resolve(
        option.size !== undefined ? option.size : written.get(path)
      );
    },
    unlink: (path: string) => {
      calls.push(`unlink ${path}`);
      return Promise.resolve();
    },
    rename: (from: string, to: string) => {
      calls.push(`rename ${from} ${to}`);
      written.set(to, written.get(from)!);
      return Promise.resolve();
    },
    renameAtomic: (from: string, to: string) => {
      calls.push(`renameAtomic ${from} ${to}`);
      return Promise.resolve();
    },
  };

  if (direct) {
    base.uploadFromLocal = (local: string, remote: string) => {
      calls.push(`uploadFromLocal ${local} ${remote}`);
      if (option.directError) {
        return Promise.reject(option.directError);
      }
      written.set(remote, CONTENT_SIZE);
      return Promise.resolve();
    };
    base.downloadToLocal = (remote: string, local: string) => {
      calls.push(`downloadToLocal ${remote} ${local}`);
      if (option.directError) {
        return Promise.reject(option.directError);
      }
      written.set(local, CONTENT_SIZE);
      return Promise.resolve();
    };
  }

  return base;
}

function createLocalFs() {
  const localFs: any = Object.create(LocalFileSystem.prototype);
  const calls: string[] = [];

  localFs.calls = calls;
  localFs.pathResolver = { join: (...parts: string[]) => parts.join('/') };
  localFs.get = (path: string) => {
    calls.push(`get ${path}`);
    return Promise.resolve(readableOf('x'.repeat(CONTENT_SIZE)));
  };
  localFs.open = () => Promise.resolve(1);
  localFs.close = () => Promise.resolve();
  localFs.put = () => Promise.resolve();
  localFs.futimes = () => Promise.resolve();
  localFs.utimes = () => Promise.resolve();
  localFs.size = () => Promise.resolve(CONTENT_SIZE);
  localFs.lstat = () => Promise.reject(new Error('not found'));

  return localFs;
}

function statOf(size: number, mtime = 0) {
  return { type: FileType.File, mode: 0o644, size, mtime, atime: mtime };
}

function downloadTask(remoteFs: any, localFs: any, transferOption: any = {}) {
  return new ImmediateRetryTask(
    { fsPath: '/remote/a.txt', fileSystem: remoteFs },
    { fsPath: '/local/a.txt', fileSystem: localFs },
    {
      fileType: FileType.File,
      transferDirection: TransferDirection.REMOTE_TO_LOCAL,
      transferOption: {
        atime: 0,
        mtime: 0,
        size: CONTENT_SIZE,
        perserveTargetMode: false,
        ...transferOption,
      },
    }
  );
}

/** Retries without the wait, so the suite doesn't spend a second sleeping. */
class ImmediateRetryTask extends TransferTask {
  protected _retryDelay(): number {
    return 0;
  }
}

function createTask(srcFs: any, targetFs: any, transferOption: any = {}) {
  return new ImmediateRetryTask(
    { fsPath: '/local/a.txt', fileSystem: srcFs },
    { fsPath: '/remote/a.txt', fileSystem: targetFs },
    {
      fileType: FileType.File,
      transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      transferOption: {
        atime: 0,
        mtime: 0,
        size: CONTENT_SIZE,
        perserveTargetMode: false,
        ...transferOption,
      },
    }
  );
}

describe('TransferTask', () => {
  it('uploads through the pipelined route when the target offers one', async () => {
    const localFs = createLocalFs();
    const remoteFs = createRemoteFs(true);

    await createTask(localFs, remoteFs).run();

    expect(remoteFs.calls).toContain('uploadFromLocal /local/a.txt /remote/a.txt');
    expect(remoteFs.calls).not.toContain('put /remote/a.txt');
    expect(localFs.calls).not.toContain('get /local/a.txt');
  });

  it('downloads through the pipelined route', async () => {
    const localFs = createLocalFs();
    const remoteFs = createRemoteFs(true);

    const task = new ImmediateRetryTask(
      { fsPath: '/remote/a.txt', fileSystem: remoteFs },
      { fsPath: '/local/a.txt', fileSystem: localFs },
      {
        fileType: FileType.File,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        transferOption: {
          atime: 0,
          mtime: 0,
          size: CONTENT_SIZE,
          perserveTargetMode: false,
        },
      }
    );
    await task.run();

    expect(remoteFs.calls).toContain('downloadToLocal /remote/a.txt /local/a.txt');
  });

  it('falls back to the stream route when neither side offers one', async () => {
    const localFs = createLocalFs();
    const remoteFs = createRemoteFs(false);

    await createTask(localFs, remoteFs).run();

    expect(remoteFs.calls).toContain('put /remote/a.txt');
    expect(localFs.calls).toContain('get /local/a.txt');
  });

  it('rejects a file that arrived short', async () => {
    const localFs = createLocalFs();
    const remoteFs = createRemoteFs(true, { size: CONTENT_SIZE - 1 });

    await expect(createTask(localFs, remoteFs).run()).rejects.toThrow(
      TransferIntegrityError
    );
  });

  it('retries a short transfer before giving up', async () => {
    const localFs = createLocalFs();
    const remoteFs = createRemoteFs(true, { size: CONTENT_SIZE - 1 });

    await expect(createTask(localFs, remoteFs).run()).rejects.toThrow(
      /arrived incomplete/
    );

    const attempts = remoteFs.calls.filter(c => c.startsWith('uploadFromLocal'));
    expect(attempts).toHaveLength(3);
  });

  it('leaves the target alone when the temp file arrived short', async () => {
    const localFs = createLocalFs();
    const remoteFs = createRemoteFs(true, { size: CONTENT_SIZE - 1 });

    await expect(
      createTask(localFs, remoteFs, { useTempFile: true }).run()
    ).rejects.toThrow(TransferIntegrityError);

    expect(remoteFs.calls.some(c => c.startsWith('rename'))).toBe(false);
    expect(remoteFs.calls).not.toContain('unlink /remote/a.txt');
  });

  it('promotes the temp file once the size checks out', async () => {
    const localFs = createLocalFs();
    const remoteFs = createRemoteFs(true);

    await createTask(localFs, remoteFs, { useTempFile: true }).run();

    expect(remoteFs.calls).toContain('uploadFromLocal /local/a.txt /remote/a.txt.new');
    expect(remoteFs.calls).toContain('rename /remote/a.txt.new /remote/a.txt');
  });

  it('retries a dropped connection', async () => {
    const localFs = createLocalFs();
    const connectionLost: any = new Error('socket hang up');
    connectionLost.code = 'ECONNRESET';
    const remoteFs = createRemoteFs(true, { directError: connectionLost });

    await expect(createTask(localFs, remoteFs).run()).rejects.toThrow(
      'socket hang up'
    );
    expect(
      remoteFs.calls.filter(c => c.startsWith('uploadFromLocal'))
    ).toHaveLength(3);
  });

  it('does not retry a failure that says something about the file', async () => {
    const localFs = createLocalFs();
    const denied: any = new Error('Permission denied');
    denied.code = 550;
    const remoteFs = createRemoteFs(true, { directError: denied });

    await expect(createTask(localFs, remoteFs).run()).rejects.toThrow(
      'Permission denied'
    );
    expect(
      remoteFs.calls.filter(c => c.startsWith('uploadFromLocal'))
    ).toHaveLength(1);
  });

  it('skips the check when the size is unknown, rather than failing', async () => {
    const localFs = createLocalFs();
    const remoteFs = createRemoteFs(true, { size: undefined });
    remoteFs.size = () => Promise.resolve(undefined);

    await createTask(localFs, remoteFs).run();
  });

  it('honours verify: false', async () => {
    const localFs = createLocalFs();
    const remoteFs = createRemoteFs(true, { size: 1 });

    await createTask(localFs, remoteFs, { verify: false }).run();

    expect(remoteFs.calls).not.toContain('size /remote/a.txt');
  });

  it('says the copy is longer than the source when it is', async () => {
    const localFs = createLocalFs();
    const remoteFs = createRemoteFs(true, { size: CONTENT_SIZE + 5 });

    await expect(createTask(localFs, remoteFs).run()).rejects.toThrow(
      /arrived longer than its source: expected 12 bytes, got 17/
    );
  });

  it('reads the file again when the source moved on, and settles', async () => {
    const localFs = createLocalFs();
    const remoteFs = createRemoteFs(true);
    remoteFs.lstat = () => {
      remoteFs.calls.push('lstat /remote/a.txt');
      return Promise.resolve(statOf(CONTENT_SIZE));
    };

    await downloadTask(remoteFs, localFs, { size: CONTENT_SIZE - 3 }).run();

    // The first read was measured against a size the listing took before the
    // server rewrote the file; the second against what it holds now.
    expect(
      remoteFs.calls.filter(c => c.startsWith('downloadToLocal'))
    ).toHaveLength(2);
  });

  it('carries the source it found into the copy it keeps', async () => {
    const localFs = createLocalFs();
    const remoteFs = createRemoteFs(true);
    remoteFs.lstat = () => Promise.resolve(statOf(CONTENT_SIZE, 5000));

    const task = downloadTask(remoteFs, localFs, {
      size: CONTENT_SIZE - 3,
      mtime: 1000,
    });
    await task.run();

    expect((task as any)._TransferOption.mtime).toBe(5000);
  });

  it('keeps the copy of a file that never stops changing', async () => {
    const localFs = createLocalFs();
    const remoteFs = createRemoteFs(true);

    // Every look at the server finds the file a byte longer than the last.
    let onDisk = CONTENT_SIZE;
    localFs.size = () => Promise.resolve(onDisk);
    remoteFs.lstat = () => Promise.resolve(statOf(onDisk++));

    await downloadTask(remoteFs, localFs, { size: CONTENT_SIZE - 3 }).run();

    expect(
      remoteFs.calls.filter(c => c.startsWith('downloadToLocal'))
    ).toHaveLength(3);
  });

  it('still fails a short download when the source has not moved', async () => {
    const localFs = createLocalFs();
    const remoteFs = createRemoteFs(true);
    remoteFs.lstat = () => Promise.resolve(statOf(CONTENT_SIZE + 4));
    localFs.size = () => Promise.resolve(CONTENT_SIZE);

    await expect(
      downloadTask(remoteFs, localFs, { size: CONTENT_SIZE + 4 }).run()
    ).rejects.toThrow(/arrived incomplete: expected 16 bytes, got 12/);
  });
});
