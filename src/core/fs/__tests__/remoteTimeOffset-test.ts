import RemoteFileSystem from '../remoteFileSystem';

/**
 * The offset is applied to every timestamp a server reports, so anything
 * wrong with it is wrong everywhere at once - and invisibly, because NaN
 * compares false against everything rather than throwing.
 */
class Probe extends RemoteFileSystem {
  _createClient() {
    return { onDisconnected: () => undefined, end: () => undefined };
  }
  get _fs(): any {
    return undefined;
  }
  connect() {
    return Promise.resolve();
  }
  lstat(): any {
    return Promise.resolve();
  }
  get(): any {
    return Promise.resolve();
  }
  put(): any {
    return Promise.resolve();
  }
  list(): any {
    return Promise.resolve([]);
  }
  mkdir(): any {
    return Promise.resolve();
  }
  ensureDir(): any {
    return Promise.resolve();
  }
  unlink(): any {
    return Promise.resolve();
  }
  rmdir(): any {
    return Promise.resolve();
  }
  rename(): any {
    return Promise.resolve();
  }
  renameAtomic(): any {
    return Promise.resolve();
  }
  readlink(): any {
    return Promise.resolve('');
  }
  symlink(): any {
    return Promise.resolve();
  }
  chmod(): any {
    return Promise.resolve();
  }
  utimes(): any {
    return Promise.resolve();
  }
  futimes(): any {
    return Promise.resolve();
  }
  open(): any {
    return Promise.resolve();
  }
  close(): any {
    return Promise.resolve();
  }
  fstat(): any {
    return Promise.resolve();
  }
  toFileStat(): any {
    return undefined;
  }
  toFileEntry(): any {
    return undefined;
  }
}

const REAL_MTIME = 1_758_000_000_000;

function probe(option: object) {
  return new Probe({ join: () => '' } as any, {
    client: { onDisconnected: () => undefined } as any,
    ...option,
  } as any);
}

describe('the remote time offset', () => {
  it('survives an option that was never set', () => {
    // The shape that broke every SFTP timestamp: the option is validated but
    // not defaulted, so it arrives as an explicit undefined and overwrites
    // the default zero in the spread.
    const fs = probe({ remoteTimeOffsetInHours: undefined });

    expect(fs.toLocalTime(REAL_MTIME)).toBe(REAL_MTIME);
    expect(Number.isNaN(fs.toLocalTime(REAL_MTIME))).toBe(false);
  });

  it('survives nonsense', () => {
    [null, NaN, 'three', {}, Infinity].forEach(offset => {
      const fs = probe({ remoteTimeOffsetInHours: offset });
      expect(fs.toLocalTime(REAL_MTIME)).toBe(REAL_MTIME);
    });
  });

  it('still applies a real offset, in both directions', () => {
    expect(probe({ remoteTimeOffsetInHours: 2 }).toLocalTime(REAL_MTIME)).toBe(
      REAL_MTIME - 2 * 3600 * 1000
    );
    expect(probe({ remoteTimeOffsetInHours: -5.5 }).toLocalTime(REAL_MTIME)).toBe(
      REAL_MTIME + 5.5 * 3600 * 1000
    );
  });

  it('can be set later without being poisoned', () => {
    const fs = probe({ remoteTimeOffsetInHours: 0 });

    fs.setRemoteTimeOffsetInHours(undefined as any);
    expect(fs.toLocalTime(REAL_MTIME)).toBe(REAL_MTIME);

    fs.setRemoteTimeOffsetInHours(1);
    expect(fs.toLocalTime(REAL_MTIME)).toBe(REAL_MTIME - 3600 * 1000);
  });
});

describe('the Node compatibility shim', () => {
  it('gives ssh2 back the util.isDate it still calls', () => {
    const util = require('util');
    const { installNodeCompat } = require('../../nodeCompat');

    installNodeCompat();

    // Removed in Node 23; ssh2 1.13 calls it whenever it encodes file
    // attributes, which is every open and every fastGet.
    expect(typeof util.isDate).toBe('function');
    expect(util.isDate(new Date())).toBe(true);
    expect(util.isDate('2026-09-20')).toBe(false);
    expect(util.isDate(undefined)).toBe(false);
  });
});
