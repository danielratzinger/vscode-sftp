import { FileType } from '../../../core/fs';
import TransferTask, { TransferDirection } from '../../../core/transferTask';
import { transfer } from '../transfer';

const FOLDER_MODE = 0o755;

function entry(name: string, mode: number) {
  return {
    fspath: `/remote/site/${name}`,
    name,
    type: FileType.File,
    mode,
    mtime: 1000,
    atime: 1000,
    size: 10,
  };
}

function createFs(entries: any[]) {
  return {
    pathResolver: {
      join: (...parts: string[]) => parts.join('/'),
      dirname: (p: string) => p.slice(0, p.lastIndexOf('/')),
    },
    lstat: () =>
      Promise.resolve({
        type: FileType.Directory,
        mode: FOLDER_MODE,
        mtime: 1000,
        atime: 1000,
        size: 0,
      }),
    list: () => Promise.resolve(entries),
    ensureDir: () => Promise.resolve(),
    chmod: () => Promise.resolve(),
  } as any;
}

async function optionsOf(entries: any[]) {
  const fs = createFs(entries);
  const collected: TransferTask[] = [];

  await transfer(
    {
      srcFsPath: '/remote/site',
      srcFs: fs,
      targetFsPath: '/local/site',
      targetFs: fs,
      transferOption: { perserveTargetMode: true } as any,
      transferDirection: TransferDirection.REMOTE_TO_LOCAL,
    } as any,
    t => collected.push(t)
  );

  return collected.map(task => (task as any)._TransferOption);
}

describe('the mode a file in a transferred folder is created with', () => {
  it('is the file’s own, not the folder’s', async () => {
    const options = await optionsOf([
      entry('index.php', 0o644),
      entry('deploy.sh', 0o755),
      entry('secret.env', 0o600),
    ]);

    expect(options.map(o => o.fallbackMode)).toEqual([0o644, 0o755, 0o600]);
    expect(options.every(o => o.fallbackMode === FOLDER_MODE)).toBe(false);
  });

  it('still carries the rest of what the listing said', async () => {
    const [option] = await optionsOf([entry('index.php', 0o644)]);

    expect(option.mtime).toBe(1000);
    expect(option.size).toBe(10);
  });
});
