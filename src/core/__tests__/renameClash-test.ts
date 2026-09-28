import {
  CANCEL,
  OVERWRITE,
  OVERWRITE_BOTH,
  SERVER_ONLY,
  isSameFile,
  renamedPath,
  whatToAsk,
  worthPassingOn,
} from '../renameName';

describe('a name that is already taken', () => {
  it('asks nothing when it is not', () => {
    const ask = whatToAsk({ remote: 'nothing', local: 'nothing' }, 'new.php');

    expect(ask.goAhead).toEqual({ overwrite: false, renameLocal: true });
    expect(ask.message).toBeUndefined();
  });

  it('refuses a folder in the way rather than offering to delete it', () => {
    // Overwriting a folder means deleting what is inside it, and nobody typing
    // a new name is asking for that.
    const onServer = whatToAsk({ remote: 'directory', local: 'nothing' }, 'app');
    const here = whatToAsk({ remote: 'nothing', local: 'directory' }, 'app');

    expect(onServer.refuse).toMatch(/folder called 'app'.*on the server/);
    expect(onServer.refuse).toMatch(/nothing was changed/);
    expect(here.refuse).toMatch(/on this machine/);
    expect(onServer.choices).toBeUndefined();
  });

  it('asks about a file on the server, where there is no third way', () => {
    const ask = whatToAsk({ remote: 'file', local: 'nothing' }, 'index.php');

    expect(ask.choices).toEqual([OVERWRITE, CANCEL]);
    expect(ask.meaning![OVERWRITE]).toEqual({ overwrite: true, renameLocal: true });
    // Cancel means nothing happens, so it carries no meaning of its own.
    expect(ask.meaning![CANCEL]).toBeUndefined();
  });

  it('offers to leave this machine alone when only its copy is in the way', () => {
    const ask = whatToAsk({ remote: 'nothing', local: 'file' }, 'index.php');

    expect(ask.choices).toEqual([OVERWRITE, SERVER_ONLY, CANCEL]);
    expect(ask.meaning![SERVER_ONLY]).toEqual({
      overwrite: false,
      renameLocal: false,
    });
  });

  it('asks once when both are in the way', () => {
    const ask = whatToAsk({ remote: 'file', local: 'file' }, 'index.php');

    expect(ask.choices).toEqual([OVERWRITE_BOTH, CANCEL]);
    expect(ask.message).toMatch(/on the server and on this machine/);
  });
});

describe('the path a rename produces', () => {
  it('keeps the folder and replaces the last part', () => {
    expect(renamedPath('/httpdocs/site/stage/README.md', 'READ.md')).toBe(
      '/httpdocs/site/stage/READ.md'
    );
  });

  it('works on something directly under the root', () => {
    expect(renamedPath('/README.md', 'READ.md')).toBe('/READ.md');
  });

  it('handles a folder, trailing slash and all', () => {
    expect(renamedPath('/httpdocs/site/old/', 'new')).toBe('/httpdocs/site/new');
  });

  it('never doubles a separator', () => {
    expect(renamedPath('/a/b', ' c ')).toBe('/a/c');
    expect(renamedPath('/a//b', 'c')).toBe('/a/c');
  });
});

describe('whether what is in the way is the same file', () => {
  const file = { size: 4096, mtime: 1_700_000_000_000 };

  it('is the same when size and second agree', () => {
    expect(isSameFile(file, { size: 4096, mtime: 1_700_000_000_400 })).toBe(true);
  });

  it('is not the same on a different size', () => {
    expect(isSameFile(file, { size: 4097, mtime: file.mtime })).toBe(false);
  });

  it('is not the same on a different second', () => {
    expect(isSameFile(file, { size: 4096, mtime: file.mtime + 2000 })).toBe(false);
  });

  it('is never the same as nothing', () => {
    // Nothing to compare is not a reason to skip the question.
    expect(isSameFile(file, null)).toBe(false);
    expect(isSameFile(null, file)).toBe(false);
    expect(isSameFile(null, null)).toBe(false);
  });
});

describe('whether a rename made here is worth putting to somebody', () => {
  const onAServer = {
    hasConnection: true,
    autosyncing: false,
    ignored: false,
    onServer: 'file' as const,
  };

  it('is, when the file is on a server this window is connected to', () => {
    expect(worthPassingOn(onAServer)).toEqual({ ask: true });
  });

  it('is not, for a file no connection covers', () => {
    expect(
      worthPassingOn({ ...onAServer, hasConnection: false }).because
    ).toMatch(/no connection/);
  });

  it('is not, where autosync is writing - it passes renames on itself', () => {
    expect(worthPassingOn({ ...onAServer, autosyncing: true }).ask).toBe(false);
  });

  it('is not, for a file the connection ignores', () => {
    expect(worthPassingOn({ ...onAServer, ignored: true }).ask).toBe(false);
  });

  it('is not, for a file the server has never seen', () => {
    // Otherwise every rename in a new folder would be a question.
    expect(
      worthPassingOn({ ...onAServer, onServer: 'nothing' }).because
    ).toMatch(/not on the server/);
  });

  it('gives a reason for every no, so the log says which it was', () => {
    const noes = [
      { ...onAServer, hasConnection: false },
      { ...onAServer, autosyncing: true },
      { ...onAServer, ignored: true },
      { ...onAServer, onServer: 'nothing' as const },
    ].map(worthPassingOn);

    expect(noes.every(one => !one.ask && Boolean(one.because))).toBe(true);
    expect(new Set(noes.map(one => one.because)).size).toBe(4);
  });
});
