import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as tls from 'tls';

/**
 * A real FTP server, in this process, serving a real directory.
 *
 * SFTP has one, and FTP is the protocol with more of its own code behind it -
 * a connection pool, a hidden-file probe, a clock-offset measurement, and a
 * transfer that holds its control connection until the data socket drains.
 * None of that was ever run against a server that speaks the protocol.
 *
 * Only what this extension actually sends is implemented, which is a small
 * part of RFC 959.
 */

export interface SecureOption {
  /** PEM key and certificate; the server then offers AUTH TLS. */
  key: Buffer | string;
  cert: Buffer | string;
}

export interface Misbehaviour {
  /** Reply 500 to `LIST -a`, like a server that does not know the flag. */
  refuseListAll?: boolean;
  /** Never answer this command, to see what waits forever. */
  stallCommand?: string;
  /**
   * Agree to `PROT P` and then serve the data connection in the clear.
   *
   * The failure that matters most here: the control connection encrypts, the
   * client expects TLS on the data connection, and the bytes arriving are not
   * TLS. A firewall or a server that cannot reuse the control session looks
   * like this from the client's side - commands fine, listings and transfers
   * broken.
   */
  breakDataTls?: boolean;
}

export interface RunningFtpServer {
  port: number;
  root: string;
  misbehave(next: Misbehaviour): void;
  /** Control connections opened so far; the pool should open more than one. */
  connections(): number;
  close(): Promise<void>;
}

function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** `-rw-r--r--   1 owner group   1234 Jan 01 00:00 name`, which is what the client parses. */
function lsLine(name: string, stat: fs.Stats): string {
  const kind = stat.isDirectory() ? 'd' : '-';
  const when = new Date(stat.mtimeMs);
  const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  const stamp =
    `${months[when.getMonth()]} ${twoDigits(when.getDate())} ` +
    `${twoDigits(when.getHours())}:${twoDigits(when.getMinutes())}`;

  return `${kind}rw-r--r--   1 owner group ${stat.size} ${stamp} ${name}`;
}

function mdtm(stat: fs.Stats): string {
  const when = new Date(stat.mtimeMs);

  return (
    `${when.getUTCFullYear()}${twoDigits(when.getUTCMonth() + 1)}` +
    `${twoDigits(when.getUTCDate())}${twoDigits(when.getUTCHours())}` +
    `${twoDigits(when.getUTCMinutes())}${twoDigits(when.getUTCSeconds())}`
  );
}

export async function startFtpServer(
  root: string,
  secure?: SecureOption
): Promise<RunningFtpServer> {
  let misbehaviour: Misbehaviour = {};
  let opened = 0;
  // Held so `close` can end them: a client that keeps its control connection
  // open would otherwise keep the server listening for ever.
  const live: net.Socket[] = [];

  const server = net.createServer(rawControl => {
    opened += 1;
    live.push(rawControl);
    let control: net.Socket | tls.TLSSocket = rawControl;
    let protectData = false;
    rawControl.on('close', () => {
      const at = live.indexOf(rawControl);
      if (at !== -1) {
        live.splice(at, 1);
      }
    });

    let cwd = '/';
    let pending: net.Server | null = null;
    // The client opens the data connection as soon as it has the PASV reply,
    // which is before it sends the command that uses it. Either can arrive
    // first, so both are held until the pair is complete.
    let dataSocket: net.Socket | tls.TLSSocket | null = null;
    let job: ((socket: any) => void) | null = null;

    const runWhenPaired = () => {
      if (!dataSocket || !job) {
        return;
      }

      const socket = dataSocket;
      const work = job;
      dataSocket = null;
      job = null;
      work(socket);
    };

    const say = (line: string) => control.write(`${line}\r\n`);
    const within = (given: string) => {
      const target = given && given.charAt(0) === '/' ? given : path.posix.join(cwd, given || '.');
      return path.join(root, path.normalize('/' + target));
    };

    /** Opens the data connection and runs `work` once the client connects. */
    const passive = (work?: (socket: any) => void) => {
      if (pending) {
        pending.close();
      }

      const data = net.createServer(socket => {
        dataSocket =
          protectData && secure && !misbehaviour.breakDataTls
            ? new tls.TLSSocket(socket, {
                isServer: true,
                secureContext: tls.createSecureContext({
                  key: secure.key as any,
                  cert: secure.cert as any,
                }),
              })
            : socket;
        runWhenPaired();
      });

      pending = data;
      if (work) {
        job = work;
      }

      data.listen(0, '127.0.0.1', () => {
        const dataPort = (data.address() as any).port;
        // tslint:disable-next-line:no-bitwise
        say(`227 Entering Passive Mode (127,0,0,1,${dataPort >> 8},${dataPort & 255})`);
      });
    };

    say('220 Test server ready');

    let buffer = '';
    const readFrom = (socket: net.Socket | tls.TLSSocket) => {
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');

        let at = buffer.indexOf('\r\n');
        while (at !== -1) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          handle(line);
          at = buffer.indexOf('\r\n');
        }
      });
      socket.on('error', () => undefined);
    };

    readFrom(rawControl);

    /**
     * FTPS upgrades the control connection in place: the client sends
     * `AUTH TLS`, the server agrees, and everything after the reply is TLS on
     * the same socket.
     */
    const upgrade = () => {
      say('234 AUTH TLS successful');
      rawControl.removeAllListeners('data');

      const secured = new tls.TLSSocket(rawControl, {
        isServer: true,
        secureContext: tls.createSecureContext({
          key: secure!.key as any,
          cert: secure!.cert as any,
        }),
      });

      control = secured;
      readFrom(secured);
    };

    function handle(line: string) {
      const space = line.indexOf(' ');
      const command = (space === -1 ? line : line.slice(0, space)).toUpperCase();
      const argument = space === -1 ? '' : line.slice(space + 1);

      if (misbehaviour.stallCommand && command === misbehaviour.stallCommand) {
        return; // Never answers.
      }

      switch (command) {
        case 'USER':
          return say('331 Password required');
        case 'PASS':
          return say('230 Logged in');
        case 'SYST':
          return say('215 UNIX Type: L8');
        case 'FEAT':
          control.write(
            '211-Features\r\n MDTM\r\n SIZE\r\n UTF8\r\n' +
              (secure ? ' AUTH TLS\r\n PBSZ\r\n PROT\r\n' : '') +
              '211 End\r\n'
          );
          return;
        case 'OPTS':
          return say('200 Ok');
        case 'AUTH':
          if (!secure || argument.toUpperCase().indexOf('TLS') !== 0) {
            return say('500 AUTH not supported');
          }
          return upgrade();
        case 'PBSZ':
          return say('200 PBSZ=0');
        case 'PROT':
          protectData = argument.toUpperCase() === 'P';
          return say('200 Protection level set');
        case 'TYPE':
          return say('200 Type set');
        case 'PWD':
          return say(`257 "${cwd}"`);
        case 'CWD':
          cwd = argument.charAt(0) === '/' ? argument : path.posix.join(cwd, argument);
          return say('250 Directory changed');
        case 'PASV':
          return passive();
        case 'QUIT':
          say('221 Goodbye');
          return control.end();
        case 'NOOP':
          return say('200 Ok');

        case 'MDTM': {
          try {
            return say(`213 ${mdtm(fs.lstatSync(within(argument)))}`);
          } catch (error) {
            return say('550 Not found');
          }
        }

        case 'SIZE': {
          try {
            return say(`213 ${fs.lstatSync(within(argument)).size}`);
          } catch (error) {
            return say('550 Not found');
          }
        }

        case 'LIST': {
          let target = argument;
          const wantsAll = target.indexOf('-a') === 0;
          if (wantsAll) {
            if (misbehaviour.refuseListAll) {
              return say('500 Unknown option');
            }
            target = target.slice(2).trim();
          }

          let entries: string[];
          try {
            entries = fs.readdirSync(within(target || '.'));
          } catch (error) {
            return say('550 Not found');
          }

          // A server that was not asked for them hides dotfiles.
          const shown = wantsAll ? entries : entries.filter(name => name.charAt(0) !== '.');

          job = socket => {
            say('150 Opening data connection');
            shown.forEach(name => {
              try {
                socket.write(`${lsLine(name, fs.lstatSync(path.join(within(target || '.'), name)))}\r\n`);
              } catch (error) {
                // Vanished between readdir and lstat; skip it.
              }
            });
            socket.end();
            socket.on('close', () => say('226 Transfer complete'));
          };
          runWhenPaired();
          return;
        }

        case 'RETR': {
          const file = within(argument);
          job = socket => {
            say('150 Opening data connection');
            const stream = fs.createReadStream(file);
            stream.on('error', () => {
              socket.end();
              say('550 Not found');
            });
            stream.pipe(socket);
            socket.on('close', () => say('226 Transfer complete'));
          };
          runWhenPaired();
          return;
        }

        case 'STOR': {
          const file = within(argument);
          job = socket => {
            say('150 Opening data connection');
            const stream = fs.createWriteStream(file);
            socket.pipe(stream);
            socket.on('end', () => say('226 Transfer complete'));
          };
          runWhenPaired();
          return;
        }

        case 'DELE':
          try {
            fs.unlinkSync(within(argument));
            return say('250 Deleted');
          } catch (error) {
            return say('550 Not found');
          }

        case 'MKD':
          try {
            fs.mkdirSync(within(argument));
            return say('257 Created');
          } catch (error) {
            return say('550 Failed');
          }

        default:
          return say('502 Not implemented');
      }
    }
  });

  const port: number = await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port))
  );

  return {
    port,
    root,
    misbehave: next => {
      misbehaviour = next;
    },
    connections: () => opened,
    close: () =>
      new Promise<void>(resolve => {
        live.slice().forEach(socket => socket.destroy());
        server.close(() => resolve());
      }),
  };
}
