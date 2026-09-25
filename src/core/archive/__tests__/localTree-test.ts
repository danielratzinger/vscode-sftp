import { FileType } from '../../fs';
import { walkLocal } from '../localTree';

function entry(dir: string, name: string, type: FileType, mode = 0o644) {
  return {
    fspath: `${dir}/${name}`,
    name,
    type,
    mode,
    mtime: 0,
    atime: 0,
    size: 1,
  };
}

/** A folder tree on disk, without the disk. */
function createFs(tree: { [dir: string]: any[] }) {
  return {
    list: (dir: string) => {
      const held = tree[dir];
      return held
        ? Promise.resolve(held)
        : Promise.reject(new Error(`cannot read ${dir}`));
    },
  } as any;
}

describe('walking a folder on this machine', () => {
  it('names every file, relative to where it started', async () => {
    const fs = createFs({
      '/local/site': [
        entry('/local/site', 'index.php', FileType.File),
        entry('/local/site', 'app', FileType.Directory),
      ],
      '/local/site/app': [
        entry('/local/site/app', 'boot.php', FileType.File, 0o600),
      ],
    });

    const tree = await walkLocal(fs, '/local/site');

    expect(tree.files).toEqual([
      { path: 'index.php', mode: 0o644 },
      { path: 'app/boot.php', mode: 0o600 },
    ]);
    expect(tree.directories).toEqual(['app']);
  });

  it('lists a folder that holds nothing, which files alone would lose', async () => {
    const fs = createFs({
      '/local/site': [entry('/local/site', 'cache', FileType.Directory)],
      '/local/site/cache': [],
    });

    const tree = await walkLocal(fs, '/local/site');

    expect(tree.directories).toEqual(['cache']);
    expect(tree.files).toEqual([]);
  });

  it('gives a symlink no mode, since chmod would follow it', async () => {
    const fs = createFs({
      '/local/site': [
        entry('/local/site', 'current', FileType.SymbolicLink, 0o777),
      ],
    });

    const tree = await walkLocal(fs, '/local/site');

    expect(tree.files).toEqual([{ path: 'current' }]);
  });

  it('applies ignore to folders as well as files', async () => {
    const fs = createFs({
      '/local/site': [
        entry('/local/site', 'index.php', FileType.File),
        entry('/local/site', 'node_modules', FileType.Directory),
      ],
      '/local/site/node_modules': [
        entry('/local/site/node_modules', 'a.js', FileType.File),
      ],
    });

    const tree = await walkLocal(fs, '/local/site', {
      ignore: fsPath => fsPath.endsWith('node_modules'),
    });

    expect(tree.files).toEqual([{ path: 'index.php', mode: 0o644 }]);
    expect(tree.directories).toEqual([]);
  });

  it('applies the file filter to files and not to folders', async () => {
    const fs = createFs({
      '/local/site': [
        entry('/local/site', 'logo.png', FileType.File),
        entry('/local/site', 'assets.png', FileType.Directory),
      ],
      '/local/site/assets.png': [
        entry('/local/site/assets.png', 'style.css', FileType.File),
      ],
    });

    const tree = await walkLocal(fs, '/local/site', {
      fileFilter: fsPath => !fsPath.endsWith('.png'),
    });

    // The folder keeps its name and its contents; only the file is left out.
    expect(tree.files).toEqual([{ path: 'assets.png/style.css', mode: 0o644 }]);
    expect(tree.directories).toEqual(['assets.png']);
  });

  it('carries on past a folder it cannot read', async () => {
    const fs = createFs({
      '/local/site': [
        entry('/local/site', 'index.php', FileType.File),
        entry('/local/site', 'locked', FileType.Directory),
      ],
    });

    const tree = await walkLocal(fs, '/local/site');

    expect(tree.files).toEqual([{ path: 'index.php', mode: 0o644 }]);
    expect(tree.directories).toEqual(['locked']);
  });
});
