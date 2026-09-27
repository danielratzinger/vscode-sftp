import {
  CANCEL,
  OVERWRITE,
  OVERWRITE_BOTH,
  SERVER_ONLY,
  whatToAsk,
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
