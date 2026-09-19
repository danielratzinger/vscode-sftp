import * as fs from 'fs';
import * as path from 'path';
import { Server, utils } from 'ssh2';

/**
 * A real SFTP server, in this process, serving a real directory.
 *
 * Every test above this line stops at `RemoteLike` and hands the code a fake.
 * That leaves the part most likely to be wrong untested: the ssh2 client, the
 * pipelined transfers, the streams, and what any of it does when a server
 * stops answering. ssh2 ships a server as well as a client, so the whole stack
 * can run against one for the price of implementing the protocol handlers -
 * and a server we control can misbehave on demand, which is the only way to
 * test a stall without waiting for one to happen in production.
 */

const { STATUS_CODE, flagsToString } = (utils as any).sftp;

export interface Misbehaviour {
  /** Paths whose READ never answers, simulating a transfer that dies mid-file. */
  stallReadsOf?: string[];
  /** Paths whose LSTAT never answers, simulating a wedged command. */
  stallStatOf?: string[];
  /** Bytes to send before a stalled read goes quiet. */
  bytesBeforeStall?: number;
}

export interface RunningServer {
  port: number;
  root: string;
  /** Changed between calls to make one operation misbehave. */
  misbehave(next: Misbehaviour): void;
  close(): Promise<void>;
}

interface OpenFile {
  fd: number;
  path: string;
  sent: number;
}

function attrsOf(stat: fs.Stats) {
  return {
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  };
}

function longname(name: string, stat: fs.Stats): string {
  const kind = stat.isDirectory() ? 'd' : '-';
  return `${kind}rw-r--r--   1 owner group ${stat.size} Jan 1 00:00 ${name}`;
}

export async function startSftpServer(root: string): Promise<RunningServer> {
  const keys = utils.generateKeyPairSync('ed25519');
  let misbehaviour: Misbehaviour = {};

  const server = new Server({ hostKeys: [keys.private] }, (client: any) => {
    client.on('authentication', (ctx: any) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (acceptSession: any) => {
        const session = acceptSession();
        session.on('sftp', (acceptSftp: any) => {
          const sftp = acceptSftp();
          serve(sftp);
        });
      });
    });
  });

  function serve(sftp: any) {
    const files: { [id: string]: OpenFile } = {};
    const dirs: { [id: string]: { entries: string[]; at: number; path: string } } = {};
    let next = 0;

    const handleFor = (id: string) => {
      const handle = Buffer.alloc(4);
      handle.writeUInt32BE(parseInt(id, 10), 0);
      return handle;
    };
    const idOf = (handle: Buffer) => String(handle.readUInt32BE(0));

    /** Everything is served from inside the root, whatever is asked for. */
    const within = (p: string) => path.join(root, path.normalize('/' + p));

    const failWith = (reqid: number, error: any) =>
      sftp.status(
        reqid,
        error && error.code === 'ENOENT'
          ? STATUS_CODE.NO_SUCH_FILE
          : STATUS_CODE.FAILURE
      );

    const stalls = (list: string[] | undefined, p: string) =>
      Boolean(list && list.some(entry => p.endsWith(entry)));

    sftp.on('REALPATH', (reqid: number, given: string) => {
      const resolved = path.posix.normalize(given === '.' ? '/' : given);
      sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} }]);
    });

    sftp.on('STAT', (reqid: number, given: string) => onStat(reqid, given));
    sftp.on('LSTAT', (reqid: number, given: string) => onStat(reqid, given));

    function onStat(reqid: number, given: string) {
      if (stalls(misbehaviour.stallStatOf, given)) {
        return; // Never answers. The client has to decide to stop waiting.
      }

      fs.lstat(within(given), (error, stat) =>
        error ? failWith(reqid, error) : sftp.attrs(reqid, attrsOf(stat))
      );
    }

    sftp.on('FSTAT', (reqid: number, handle: Buffer) => {
      const open = files[idOf(handle)];
      if (!open) {
        return sftp.status(reqid, STATUS_CODE.FAILURE);
      }
      fs.fstat(open.fd, (error, stat) =>
        error ? failWith(reqid, error) : sftp.attrs(reqid, attrsOf(stat))
      );
    });

    sftp.on('OPENDIR', (reqid: number, given: string) => {
      fs.readdir(within(given), (error, entries) => {
        if (error) {
          return failWith(reqid, error);
        }
        const id = String(next++);
        dirs[id] = { entries, at: 0, path: given };
        sftp.handle(reqid, handleFor(id));
      });
    });

    sftp.on('READDIR', (reqid: number, handle: Buffer) => {
      const dir = dirs[idOf(handle)];
      if (!dir) {
        return sftp.status(reqid, STATUS_CODE.FAILURE);
      }
      if (dir.at >= dir.entries.length) {
        return sftp.status(reqid, STATUS_CODE.EOF);
      }

      const names = dir.entries.slice(dir.at).map(name => {
        const stat = fs.lstatSync(path.join(within(dir.path), name));
        return { filename: name, longname: longname(name, stat), attrs: attrsOf(stat) };
      });
      dir.at = dir.entries.length;
      sftp.name(reqid, names);
    });

    sftp.on('OPEN', (reqid: number, filename: string, flags: number) => {
      const asString = flagsToString(flags) || 'r';
      fs.open(within(filename), asString, (error, fd) => {
        if (error) {
          return failWith(reqid, error);
        }
        const id = String(next++);
        files[id] = { fd, path: filename, sent: 0 };
        sftp.handle(reqid, handleFor(id));
      });
    });

    sftp.on('READ', (reqid: number, handle: Buffer, offset: number, length: number) => {
      const open = files[idOf(handle)];
      if (!open) {
        return sftp.status(reqid, STATUS_CODE.FAILURE);
      }

      // By offset rather than by bytes already sent: a pipelined transfer
      // issues dozens of reads before any of them completes, so a running
      // total never trips and the stall would never happen.
      if (
        stalls(misbehaviour.stallReadsOf, open.path) &&
        offset >= (misbehaviour.bytesBeforeStall || 0)
      ) {
        return; // Mid-transfer silence: the bytes stop and nothing says why.
      }

      const buffer = Buffer.alloc(length);
      fs.read(open.fd, buffer, 0, length, offset, (error, read) => {
        if (error) {
          return failWith(reqid, error);
        }
        if (read === 0) {
          return sftp.status(reqid, STATUS_CODE.EOF);
        }
        open.sent += read;
        sftp.data(reqid, buffer.slice(0, read));
      });
    });

    sftp.on('WRITE', (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
      const open = files[idOf(handle)];
      if (!open) {
        return sftp.status(reqid, STATUS_CODE.FAILURE);
      }
      fs.write(open.fd, data, 0, data.length, offset, error =>
        error ? failWith(reqid, error) : sftp.status(reqid, STATUS_CODE.OK)
      );
    });

    sftp.on('CLOSE', (reqid: number, handle: Buffer) => {
      const id = idOf(handle);
      if (dirs[id]) {
        delete dirs[id];
        return sftp.status(reqid, STATUS_CODE.OK);
      }

      const open = files[id];
      if (!open) {
        return sftp.status(reqid, STATUS_CODE.FAILURE);
      }
      delete files[id];
      fs.close(open.fd, error =>
        error ? failWith(reqid, error) : sftp.status(reqid, STATUS_CODE.OK)
      );
    });

    const ok = (reqid: number) => (error: any) =>
      error ? failWith(reqid, error) : sftp.status(reqid, STATUS_CODE.OK);

    sftp.on('SETSTAT', (reqid: number, given: string, attrs: any) => {
      if (attrs && attrs.atime !== undefined && attrs.mtime !== undefined) {
        return fs.utimes(within(given), attrs.atime, attrs.mtime, ok(reqid));
      }
      if (attrs && attrs.mode !== undefined) {
        return fs.chmod(within(given), attrs.mode, ok(reqid));
      }
      sftp.status(reqid, STATUS_CODE.OK);
    });

    sftp.on('FSETSTAT', (reqid: number, handle: Buffer, attrs: any) => {
      const open = files[idOf(handle)];
      if (!open) {
        return sftp.status(reqid, STATUS_CODE.FAILURE);
      }
      if (attrs && attrs.atime !== undefined && attrs.mtime !== undefined) {
        return fs.futimes(open.fd, attrs.atime, attrs.mtime, ok(reqid));
      }
      sftp.status(reqid, STATUS_CODE.OK);
    });

    sftp.on('MKDIR', (reqid: number, given: string) =>
      fs.mkdir(within(given), ok(reqid))
    );
    sftp.on('RMDIR', (reqid: number, given: string) =>
      fs.rmdir(within(given), ok(reqid))
    );
    sftp.on('REMOVE', (reqid: number, given: string) =>
      fs.unlink(within(given), ok(reqid))
    );
    sftp.on('RENAME', (reqid: number, from: string, to: string) =>
      fs.rename(within(from), within(to), ok(reqid))
    );
  }

  const port: number = await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port))
  );

  return {
    port,
    root,
    misbehave: (nextOne: Misbehaviour) => {
      misbehaviour = nextOne;
    },
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
      }),
  };
}
