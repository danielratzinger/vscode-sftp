import { Readable } from 'stream';
import { FileType } from '../../../core/fs';
import TransferTask, { TransferDirection } from '../../../core/transferTask';
import ArchiveDownloadTask from '../../../core/archive/archiveDownloadTask';
import ArchiveUploadTask from '../../../core/archive/archiveUploadTask';
import { ARCHIVE_FILE_THRESHOLD } from '../../../core/archive';
import { PROBE_COMMAND } from '../../../core/archive/serverTar';
import { transfer } from '../transfer';

function readableOf(text: string): Readable {
  const stream = new Readable();
  stream.push(text);
  stream.push(null);
  return stream;
}

const FOLDER = {
  type: FileType.Directory,
  mode: 0o755,
  mtime: 1000,
  atime: 1000,
  size: 0,
};

function entry(name: string, type = FileType.File) {
  return {
    fspath: `/remote/site/${name}`,
    name,
    type,
    mode: 0o644,
    mtime: 1000,
    atime: 1000,
    size: 3,
  };
}

/**
 * A server that answers the probe, and whatever the test says for the command
 * that would pack the folder.
 */
function createRemoteFs({
  exec = true,
  hasTar = true,
  packFails = false,
  entries = [entry('index.php')],
}: {
  exec?: boolean;
  hasTar?: boolean;
  packFails?: boolean;
  entries?: any[];
} = {}) {
  const commands: string[] = [];
  const calls: string[] = [];

  const fs: any = {
    commands,
    calls,
    pathResolver: {
      join: (...parts: string[]) => parts.join('/'),
      dirname: (p: string) => p.slice(0, p.lastIndexOf('/')),
    },
    lstat: () => Promise.resolve(FOLDER),
    list: (dir: string) => {
      calls.push(`list ${dir}`);
      // Only the top folder holds anything, or a folder inside it would list
      // itself for ever.
      return Promise.resolve(dir === '/remote/site' ? entries : []);
    },
  };

  if (exec) {
    fs.exec = (command: string) => {
      commands.push(command);

      if (command === PROBE_COMMAND) {
        return Promise.resolve({
          stdin: null,
          stdout: readableOf(hasTar ? 'tar (GNU tar) 1.34' : ''),
          stderr: () => '',
          done: Promise.resolve(hasTar ? 0 : 127),
          cancel: () => undefined,
        });
      }

      if (packFails) {
        return Promise.reject(new Error('tar: Permission denied'));
      }

      return Promise.resolve({
        stdin: null,
        stdout: readableOf('not an archive'),
        stderr: () => '',
        done: Promise.resolve(0),
        cancel: () => undefined,
      });
    };
  }

  return fs;
}

function createLocalFs() {
  return {
    pathResolver: {
      join: (...parts: string[]) => parts.join('/'),
      dirname: (p: string) => p.slice(0, p.lastIndexOf('/')),
    },
    ensureDir: () => Promise.resolve(),
    chmod: () => Promise.resolve(),
    lstat: () => Promise.reject(new Error('not found')),
  } as any;
}

async function downloadFolder(remoteFs: any, option: any = {}) {
  const collected: TransferTask[] = [];

  await transfer(
    {
      srcFsPath: '/remote/site',
      srcFs: remoteFs,
      targetFsPath: '/local/site',
      targetFs: createLocalFs(),
      transferOption: {
        perserveTargetMode: false,
        useArchiveTransfer: true,
        ...option,
      } as any,
      transferDirection: TransferDirection.REMOTE_TO_LOCAL,
    } as any,
    t => collected.push(t)
  );

  return collected;
}

describe('which way a folder download goes', () => {
  it('asks for one archive when the server can pack', async () => {
    const remoteFs = createRemoteFs();

    const collected = await downloadFolder(remoteFs);

    expect(collected).toHaveLength(1);
    expect(collected[0]).toBeInstanceOf(ArchiveDownloadTask);
    // No listing at all: the recursion is the server's to do.
    expect(remoteFs.calls).toEqual([]);
  });

  it('goes file by file when the connection has it switched off', async () => {
    const remoteFs = createRemoteFs();

    const collected = await downloadFolder(remoteFs, { useArchiveTransfer: false });

    expect(collected.some(t => t instanceof ArchiveDownloadTask)).toBe(false);
    expect(remoteFs.calls).toEqual(['list /remote/site']);
    expect(remoteFs.commands).toEqual([]);
  });

  it('goes file by file when the server will not run a command', async () => {
    const remoteFs = createRemoteFs({ exec: false });

    const collected = await downloadFolder(remoteFs);

    expect(collected.some(t => t instanceof ArchiveDownloadTask)).toBe(false);
    expect(remoteFs.calls).toEqual(['list /remote/site']);
  });

  it('goes file by file when the server has no tar', async () => {
    const remoteFs = createRemoteFs({ hasTar: false });

    const collected = await downloadFolder(remoteFs);

    expect(collected.some(t => t instanceof ArchiveDownloadTask)).toBe(false);
    expect(remoteFs.commands).toEqual([PROBE_COMMAND]);
    expect(remoteFs.calls).toEqual(['list /remote/site']);
  });

  it('hands over to the walk when the archive will not start', async () => {
    const remoteFs = createRemoteFs({ packFails: true });
    const collected = await downloadFolder(remoteFs);

    expect(collected).toHaveLength(1);
    await collected[0].run();

    // The folder still arrives, one file at a time, through the same collector.
    expect(remoteFs.calls).toEqual(['list /remote/site']);
    expect(collected).toHaveLength(2);
    expect(collected[1]).not.toBeInstanceOf(ArchiveDownloadTask);
  });

  it('does not ask for an archive again inside the walk it fell back to', async () => {
    const remoteFs = createRemoteFs({
      packFails: true,
      entries: [entry('app', FileType.Directory)],
    });

    const collected = await downloadFolder(remoteFs);
    await collected[0].run();

    // Probe, then the pack that failed. The folder inside asks for neither.
    expect(remoteFs.commands).toHaveLength(2);
    expect(remoteFs.calls).toEqual(['list /remote/site', 'list /remote/site/app']);
  });
});

/** A local folder holding as many files as the test asks for. */
function createLocalSource(count: number) {
  const calls: string[] = [];
  const files = Array.from({ length: count }, (_, i) =>
    entry(`file${i}.php`)
  );

  return {
    calls,
    pathResolver: {
      join: (...parts: string[]) => parts.join('/'),
      dirname: (p: string) => p.slice(0, p.lastIndexOf('/')),
    },
    lstat: () => Promise.resolve(FOLDER),
    list: (dir: string) => {
      calls.push(`list ${dir}`);
      return Promise.resolve(dir === '/remote/site' ? files : []);
    },
  } as any;
}

async function uploadFolder(localFs: any, remoteFs: any, option: any = {}) {
  const collected: TransferTask[] = [];

  await transfer(
    {
      srcFsPath: '/remote/site',
      srcFs: localFs,
      targetFsPath: '/var/www/site',
      targetFs: remoteFs,
      transferOption: {
        perserveTargetMode: true,
        useTempFile: true,
        useArchiveTransfer: true,
        ...option,
      } as any,
      transferDirection: TransferDirection.LOCAL_TO_REMOTE,
    } as any,
    t => collected.push(t)
  );

  return collected;
}

describe('which way a folder upload goes', () => {
  function createTarget() {
    const fs = createRemoteFs();
    fs.ensureDir = () => Promise.resolve();
    fs.chmod = () => Promise.resolve();
    return fs;
  }

  it('sends one archive once there are more files than it is worth for', async () => {
    const localFs = createLocalSource(ARCHIVE_FILE_THRESHOLD + 1);
    const remoteFs = createTarget();

    const collected = await uploadFolder(localFs, remoteFs);

    expect(collected).toHaveLength(1);
    expect(collected[0]).toBeInstanceOf(ArchiveUploadTask);
  });

  it('goes file by file for a folder of a few, and asks the server nothing', async () => {
    const localFs = createLocalSource(ARCHIVE_FILE_THRESHOLD);
    const remoteFs = createTarget();

    const collected = await uploadFolder(localFs, remoteFs);

    expect(collected.some(t => t instanceof ArchiveUploadTask)).toBe(false);
    expect(collected).toHaveLength(ARCHIVE_FILE_THRESHOLD);
    // The walk that counted them is on this machine; nothing was asked of the
    // server to find out that an archive was not worth it.
    expect(remoteFs.commands).toEqual([]);
  });

  it('goes file by file when the server cannot run a command', async () => {
    const localFs = createLocalSource(ARCHIVE_FILE_THRESHOLD + 1);
    const remoteFs = createTarget();
    delete remoteFs.exec;

    const collected = await uploadFolder(localFs, remoteFs);

    expect(collected.some(t => t instanceof ArchiveUploadTask)).toBe(false);
  });

  it('goes file by file when it is switched off for the connection', async () => {
    const localFs = createLocalSource(ARCHIVE_FILE_THRESHOLD + 1);
    const remoteFs = createTarget();

    const collected = await uploadFolder(localFs, remoteFs, {
      useArchiveTransfer: false,
    });

    expect(collected.some(t => t instanceof ArchiveUploadTask)).toBe(false);
    expect(remoteFs.commands).toEqual([]);
  });
});
