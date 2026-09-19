import upath from '../../upath';
import FTPFileSystem from '../ftpFileSystem';

function entry(name: string) {
  return {
    name,
    type: '-',
    size: 1,
    date: new Date(0),
    rights: { user: 'rw', group: 'r', other: 'r' },
  };
}

const DOT_AND_DOTDOT = [entry('.'), entry('..')];

function createFs(
  respond: (path: string) => any[],
  option: object = {}
): { fs: FTPFileSystem; calls: string[] } {
  const fs = new FTPFileSystem(upath, { client: {} as any, ...option });
  const calls: string[] = [];

  // Stand in for the data connection, so we only see what got asked of the server.
  (fs as any)._rawList = (path: string) =>
    Promise.resolve().then(() => {
      calls.push(path);
      return respond(path);
    });

  return { fs, calls };
}

function names(entries: { name: string }[]) {
  return entries.map(e => e.name);
}

describe('FTPFileSystem#list', () => {
  it('asks for hidden files with the -a flag', async () => {
    const { fs, calls } = createFs(path =>
      path.startsWith('-a ') ? [...DOT_AND_DOTDOT, entry('.env'), entry('a')] : [entry('a')]
    );

    expect(names(await fs.list('/pub'))).toEqual(['.env', 'a']);
    expect(calls).toEqual(['-a /pub']);
  });

  it('falls back to a plain LIST when the server rejects the flag', async () => {
    const { fs, calls } = createFs(path => {
      if (path.startsWith('-a ')) throw new Error('550 Failed to open file.');
      return [entry('a')];
    });

    expect(names(await fs.list('/pub'))).toEqual(['a']);
    expect(calls).toEqual(['-a /pub', '/pub']);

    // The verdict sticks, so the flag isn't retried on every listing.
    calls.length = 0;
    expect(names(await fs.list('/pub'))).toEqual(['a']);
    expect(calls).toEqual(['/pub']);
  });

  it('falls back when the server takes the flag for part of the file name', async () => {
    const { fs, calls } = createFs(path => (path.startsWith('-a ') ? [] : [entry('a')]));

    expect(names(await fs.list('/pub'))).toEqual(['a']);
    expect(calls).toEqual(['-a /pub', '/pub']);

    calls.length = 0;
    await fs.list('/pub');
    expect(calls).toEqual(['/pub']);
  });

  it('does not give up on the flag because a directory is empty', async () => {
    const { fs, calls } = createFs(path => (path.startsWith('-a ') ? DOT_AND_DOTDOT : []));

    expect(await fs.list('/empty')).toEqual([]);

    calls.length = 0;
    await fs.list('/empty');
    expect(calls[0]).toBe('-a /empty');
  });

  it('does not give up on the flag because a path contains whitespace', async () => {
    const { fs, calls } = createFs(path => {
      if (path === '-a /my dir') throw new Error('550 Failed to open file.');
      return path.startsWith('-a ') ? [...DOT_AND_DOTDOT, entry('.env')] : [];
    });

    expect(names(await fs.list('/my dir'))).toEqual([]);
    expect(calls).toEqual(['-a /my dir', '/my dir']);

    calls.length = 0;
    expect(names(await fs.list('/pub'))).toEqual(['.env']);
    expect(calls).toEqual(['-a /pub']);
  });

  it('never sends the flag when showHiddenFiles is off', async () => {
    const { fs, calls } = createFs(() => [entry('a')], { showHiddenFiles: false });

    expect(names(await fs.list('/pub'))).toEqual(['a']);
    expect(calls).toEqual(['/pub']);
  });
});

interface FakeFtp {
  name: string;
  busy: boolean;
  put: (input: any, path: string, cb: (err?: Error) => void) => void;
  get: (path: string, cb: (err: Error | null, stream?: any) => void) => void;
}

function createFakeClient(name: string, log: string[]): any {
  const ftp: FakeFtp = {
    name,
    busy: false,
    put(_input, path, cb) {
      // A real control connection can only carry one transfer at a time.
      expect(ftp.busy).toBe(false);
      ftp.busy = true;
      log.push(`${name} put ${path}`);
      setTimeout(() => {
        ftp.busy = false;
        cb();
      }, 10);
    },
    get(path, cb) {
      ftp.busy = true;
      log.push(`${name} get ${path}`);
      const stream: any = new (require('stream').PassThrough)();
      stream.on('end', () => (ftp.busy = false));
      setTimeout(() => cb(null, stream), 0);
    },
  };

  return {
    getFsClient: () => ftp,
    connectOption: { password: 'secret' },
    connect: () => Promise.resolve(),
    end: () => undefined,
    onDisconnected: () => undefined,
  };
}

function createPooledFs(connectionLimit: number) {
  const log: string[] = [];
  let extras = 0;

  class TestFTPFileSystem extends FTPFileSystem {
    _createClient(): any {
      extras += 1;
      return createFakeClient(`extra-${extras}`, log);
    }
  }

  const fs = new TestFTPFileSystem(upath, {
    client: createFakeClient('primary', log),
    connectionLimit,
  } as any);

  return { fs, log };
}

describe('FTPFileSystem connections', () => {
  it('runs parallel uploads on separate connections', async () => {
    const { fs, log } = createPooledFs(2);

    await Promise.all([
      fs.put({ once: () => undefined, removeListener: () => undefined } as any, '/a'),
      fs.put({ once: () => undefined, removeListener: () => undefined } as any, '/b'),
    ]);

    expect(log.sort()).toEqual(['extra-1 put /b', 'primary put /a']);
  });

  it('keeps a single connection when the limit says so', async () => {
    const { fs, log } = createPooledFs(1);

    await Promise.all([
      fs.put({ once: () => undefined, removeListener: () => undefined } as any, '/a'),
      fs.put({ once: () => undefined, removeListener: () => undefined } as any, '/b'),
    ]);

    expect(log).toEqual(['primary put /a', 'primary put /b']);
  });

  it('holds a download\'s connection until the stream is drained', async () => {
    const { fs, log } = createPooledFs(1);

    const stream = await fs.get('/a');

    // The connection is still carrying this download, so a second operation
    // must wait rather than be pipelined onto the same one.
    let second = false;
    const pending = fs
      .put({ once: () => undefined, removeListener: () => undefined } as any, '/b')
      .then(() => (second = true));

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(second).toBe(false);
    expect(log).toEqual(['primary get /a']);

    stream.resume();
    (stream as any).end();
    await pending;
    expect(log).toEqual(['primary get /a', 'primary put /b']);
  });
});


/**
 * A server in `serverUtcOffsetHours`, holding one file. Both timestamps are
 * built the way node-ftp builds them, which is what the measurement reads.
 */
function createClockClient(serverUtcOffsetHours: number, fileUtc: Date, log: string[]): any {
  const localOffsetMs = -fileUtc.getTimezoneOffset() * 60 * 1000;

  // LIST: the server's wall clock, parsed as if it were ours.
  const serverWallClock = new Date(
    fileUtc.getTime() + serverUtcOffsetHours * 3600 * 1000
  );
  const listed = new Date(
    serverWallClock.getUTCFullYear(),
    serverWallClock.getUTCMonth(),
    serverWallClock.getUTCDate(),
    serverWallClock.getUTCHours(),
    serverWallClock.getUTCMinutes(),
    serverWallClock.getUTCSeconds()
  );

  // MDTM: the same moment in UTC, also parsed as if it were ours.
  const asUtc = new Date(
    fileUtc.getUTCFullYear(),
    fileUtc.getUTCMonth(),
    fileUtc.getUTCDate(),
    fileUtc.getUTCHours(),
    fileUtc.getUTCMinutes(),
    fileUtc.getUTCSeconds()
  );

  const ftp = {
    localOffsetMs,
    trueTime: fileUtc.getTime(),
    list(path: string, cb: (err: Error | null, stats?: any[]) => void) {
      log.push(`list ${path}`);
      setTimeout(
        () => cb(null, [{ name: 'a.txt', type: '-', size: 1, date: listed, rights: {} }]),
        0
      );
    },
    lastMod(path: string, cb: (err: Error | null, date?: Date) => void) {
      log.push(`lastMod ${path}`);
      setTimeout(() => cb(null, asUtc), 0);
    },
  };

  return {
    getFsClient: () => ftp,
    connectOption: { password: 'x' },
    connect: () => Promise.resolve(),
    end: () => undefined,
    onDisconnected: () => undefined,
  };
}

describe('FTPFileSystem time offset', () => {
  const FILE_UTC = new Date('2024-01-15T00:00:00Z');

  function createClockFs(serverUtcOffsetHours: number, option: object = {}) {
    const log: string[] = [];
    const client = createClockClient(serverUtcOffsetHours, FILE_UTC, log);
    const fs = new FTPFileSystem(upath, {
      client,
      connectionLimit: 1,
      ...option,
    } as any);

    return { fs, log };
  }

  it('brings a listing back to the real time, whatever the server keeps', async () => {
    for (const serverOffset of [0, 9, -5, 5.5]) {
      const { fs } = createClockFs(serverOffset);
      const entries = await fs.list('/pub');

      expect(entries).toHaveLength(1);
      expect(entries[0].mtime).toBe(FILE_UTC.getTime());
    }
  });

  it('asks the server the time only once per connection', async () => {
    const { fs, log } = createClockFs(9);

    await fs.list('/pub');
    await fs.list('/pub');
    await fs.list('/other');

    expect(log.filter(line => line.startsWith('lastMod'))).toHaveLength(1);
  });

  it('measures against a file in the directory being listed', async () => {
    const { fs, log } = createClockFs(9);

    await fs.list('/pub');

    expect(log).toContain('lastMod /pub/a.txt');
  });

  it('leaves a configured offset alone', async () => {
    const { fs, log } = createClockFs(9, { remoteTimeOffsetInHours: 0 });

    const entries = await fs.list('/pub');

    // No measurement, so the listing keeps whatever the server said.
    expect(log.some(line => line.startsWith('lastMod'))).toBe(false);
    expect(entries[0].mtime).not.toBe(FILE_UTC.getTime());
  });

  it('carries on without an offset when MDTM is refused', async () => {
    const log: string[] = [];
    const client = createClockClient(9, FILE_UTC, log);
    client.getFsClient().lastMod = (_path: string, cb: any) =>
      setTimeout(() => cb(new Error('502 Command not implemented')), 0);

    const fs = new FTPFileSystem(upath, { client, connectionLimit: 1 } as any);

    const entries = await fs.list('/pub');
    expect(entries).toHaveLength(1);
  });

  it('tries again in the next directory when this one has no files', async () => {
    const log: string[] = [];
    const client = createClockClient(9, FILE_UTC, log);
    const original = client.getFsClient().list;
    // Keyed on the path, not the call: the hidden-files probe lists a
    // directory twice when the first answer comes back empty.
    client.getFsClient().list = (path: string, cb: any) => {
      if (path.indexOf('/empty') !== -1) {
        log.push(`list ${path}`);
        return setTimeout(() => cb(null, []), 0);
      }
      return original(path, cb);
    };

    const fs = new FTPFileSystem(upath, { client, connectionLimit: 1 } as any);

    await fs.list('/empty');
    expect(log.some(line => line.startsWith('lastMod'))).toBe(false);

    const entries = await fs.list('/pub');
    expect(log).toContain('lastMod /pub/a.txt');
    expect(entries[0].mtime).toBe(FILE_UTC.getTime());
  });
});

describe('FTPFileSystem timeouts', () => {
  /** A pool whose one connection never answers anything. */
  function deafFs(timeout = 20) {
    const destroyed: string[] = [];
    const released: string[] = [];
    let invalidated = false;

    const raw = {
      list: () => undefined,
      size: () => undefined,
      destroy: () => destroyed.push('destroy'),
    };
    const client = { getFsClient: () => raw, end: () => destroyed.push('end') };
    const lease = {
      client,
      invalidate: () => {
        invalidated = true;
      },
    };

    const fs = new FTPFileSystem(upath, { client: {} as any } as any);
    (fs as any)._operationTimeout = timeout;
    (fs as any)._pool = {
      acquire: () => Promise.resolve(lease),
      release: () => released.push('released'),
      discard: () => undefined,
      end: () => undefined,
    };

    return { fs, destroyed, released, was: () => invalidated };
  }

  it('gives up on a command the server never answers', async () => {
    const { fs } = deafFs();

    const error = await fs.list('/pub').catch(e => e);

    expect(error.name).toBe('OperationTimeoutError');
    expect(error.message).toContain('LIST');
  });

  it('destroys the connection it gave up on', async () => {
    // Nothing can be sent down it again - not even QUIT, which would queue
    // behind the command that is stuck.
    const { fs, destroyed, was } = deafFs();

    await fs.list('/pub').catch(() => undefined);

    expect(destroyed).toEqual(['destroy']);
    expect(was()).toBe(true);
  });

  it('gives the connection back to the pool either way', async () => {
    const { fs, released } = deafFs();

    await fs.list('/pub').catch(() => undefined);

    // Otherwise the lease leaks and the pool empties one stall at a time,
    // until every transfer waits for a connection that is never coming back.
    expect(released).toEqual(['released']);
  });

  it('leaves the deadline off when it is set to zero', async () => {
    const { fs } = deafFs(0);
    let settled = false;

    fs.list('/pub').then(() => (settled = true), () => (settled = true));
    await new Promise(done => setTimeout(done, 60));

    expect(settled).toBe(false);
  });
});

describe('what a stall must not be mistaken for', () => {
  it('does not decide the server lacks LIST -a because a listing stalled', async () => {
    // The flag probe reads a failure as a verdict about the server. A timeout
    // is a verdict about the moment, and would otherwise switch hidden files
    // off for the rest of the session.
    let attempts = 0;
    const { fs, calls } = createFs(path => {
      attempts += 1;
      if (attempts === 1) {
        const stall: any = new Error('LIST did not answer within 60s');
        stall.name = 'OperationTimeoutError';
        throw stall;
      }
      return [entry('.env'), entry('a')];
    });

    await expect(fs.list('/pub')).rejects.toThrow('did not answer');
    expect(calls).toEqual(['-a /pub']);

    // The next listing still asks for hidden files.
    expect(names(await fs.list('/pub'))).toEqual(['.env', 'a']);
    expect(calls).toEqual(['-a /pub', '-a /pub']);
  });
});
