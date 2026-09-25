import { ExecChannel } from '../remote-client/sshClient';
import logger from '../../logger';

/**
 * Which tar is on the other end.
 *
 * It matters because the two disagree about the flags that decide whether an
 * existing file is written through or unlinked and recreated, and because the
 * shell around them - `chmod --reference`, `stat -c` - is GNU coreutils on one
 * and something else on the other. A server whose tar is neither gets the
 * file-by-file transfer, which needs nothing but SFTP.
 */
export type TarFlavour = 'gnu' | 'bsd';

/** Anything that can run a command on the server. */
export interface ExecHost {
  exec(command: string): Promise<ExecChannel>;
  /** How long the connection allows an operation to say nothing. */
  operationTimeout?: number;
}

/**
 * Asked once per connection: both `tar` and `gzip` have to be there, and the
 * version text says which tar it is. `command -v` decides the exit code, so a
 * server with no tar at all answers without printing anything to parse.
 */
export const PROBE_COMMAND =
  'command -v tar >/dev/null && command -v gzip >/dev/null && tar --version 2>&1';

/** Reads the flavour out of what `tar --version` printed. */
export function readFlavour(output: string): TarFlavour | null {
  if (/bsdtar|libarchive/i.test(output)) {
    return 'bsd';
  }

  if (/GNU tar/i.test(output)) {
    return 'gnu';
  }

  return null;
}

/**
 * A path as a single shell word.
 *
 * Single quotes take everything literally, which leaves only the quote itself
 * to deal with: end the quoting, escape one, start again. A remote path comes
 * from a config file somebody else may have written, so nothing here may be
 * left for a shell to interpret.
 */
export function quote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * What every pack command says, whatever it is packing.
 *
 * `pax` rather than the default format because it carries atime and ctime in
 * extended headers, and a transfer here has always set both. `--numeric-owner`
 * spares the server a passwd lookup per entry, for ids that are thrown away on
 * arrival anyway. Symlinks are *not* followed: a transfer has always recreated
 * them as links on the other side, and following them would silently turn one
 * into a copy of what it points at.
 *
 * GNU is additionally told that a file it cannot read is a complaint and not a
 * failure, because that is what it is file by file: one file is missed and the
 * rest of the transfer stands. What the other tar does instead is fail, which
 * falls back to the file-by-file transfer and gets there the long way round.
 */
function packFlags(flavour: TarFlavour): string {
  const common = '--format=pax --numeric-owner';
  return flavour === 'gnu' ? `${common} --ignore-failed-read` : common;
}

/**
 * Streams a folder and everything under it to standard output.
 *
 * Nothing is excluded here, on purpose. The walk's filters are consulted as
 * the archive is read instead, because tar's `--exclude` applies to folders as
 * well as files: `*.png` would take a folder called that and everything inside
 * it, and a script lost that way is lost without a word.
 */
export function packFolderCommand(flavour: TarFlavour, dir: string): string {
  return `tar ${packFlags(flavour)} -czf - -C ${quote(dir)} .`;
}

/**
 * Streams a named list of files, read as NUL-separated names on standard
 * input, all of them relative to `dir`.
 *
 * NUL-separated because a file name may contain anything a file name may
 * contain, newlines included, and a list separated by newlines would split one
 * such name into two that do not exist.
 */
export function packListCommand(flavour: TarFlavour, dir: string): string {
  return `tar ${packFlags(flavour)} -czf - -C ${quote(dir)} --null -T -`;
}

interface Probe {
  flavour: TarFlavour;
}

const asked = new WeakMap<ExecHost, Promise<Probe | null>>();

/**
 * What the server can do, asked once and kept for as long as the connection
 * lives. A reconnect brings a new file system object, so it asks again - which
 * is right, since it may not be the same server behind the same name.
 */
export function serverTar(host: ExecHost): Promise<Probe | null> {
  const held = asked.get(host);
  if (held) {
    return held;
  }

  const asking = probe(host);
  asked.set(host, asking);
  return asking;
}

async function probe(host: ExecHost): Promise<Probe | null> {
  let channel: ExecChannel;
  try {
    channel = await host.exec(PROBE_COMMAND);
  } catch (error) {
    // A server set up for file transfer only refuses to run anything at all.
    logger.info(`[archive] no exec channel on this server: ${error.message}`);
    return null;
  }

  // Both, not just the exit code: the code can land before the last of the
  // output has been handed over, and a version line read too early says
  // nothing at all. Gathering also stops when the command is over, so a stream
  // that never ends cannot leave this waiting for it.
  const gathered = new Promise<string>(resolve => {
    let said = '';
    const finish = () => resolve(said);

    channel.stdout.on('data', (chunk: Buffer) => {
      said += chunk.toString();
    });
    channel.stdout.once('end', finish);
    channel.stdout.once('close', finish);
    channel.stdout.once('error', finish);
    channel.done.then(() => setImmediate(finish), () => setImmediate(finish));
  });

  const [code, said] = await Promise.all([channel.done, gathered]);
  if (code !== 0) {
    logger.info(
      `[archive] this server has no tar and gzip to use (exit ${code})` +
        (channel.stderr() ? `: ${channel.stderr()}` : '')
    );
    return null;
  }

  const flavour = readFlavour(said);
  if (!flavour) {
    logger.info(
      `[archive] cannot tell which tar this is, so not using it: ` +
        said.split('\n')[0]
    );
    return null;
  }

  logger.info(`[archive] using the server's tar (${flavour})`);
  return { flavour };
}

/**
 * Whether this side can run a command at all. FTP cannot, and neither can a
 * local file system, so the archive route is off the table for both.
 */
export function canExec(fs: any): fs is ExecHost {
  return !!fs && typeof fs.exec === 'function';
}

/** Forgets what was asked, so the next call asks again. Tests use it. */
export function forgetServerTar(host: ExecHost): void {
  asked.delete(host);
}
