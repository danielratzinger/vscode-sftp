import { TarFlavour, quote } from './serverTar';

/**
 * The two commands an upload sends: one that unpacks into a staging folder
 * beside the files, and one that puts each file in its place.
 *
 * Written out here, line by line, rather than left to a loop on the server.
 * The server's shell is whatever the login shell happens to be - sh, dash,
 * bash, zsh - and the tricks needed to loop safely over names that may contain
 * anything (`find -print0`, `read -r -d ''`) are not the same in all of them.
 * Every path is quoted here instead, by code that can be tested.
 */

/** Where the staging folder goes, and what marks it as ours. */
const STAGING_PREFIX = '.sftp-archive-';

export function stagingName(id: string): string {
  return `${STAGING_PREFIX}${id}`;
}

/**
 * Inside the target rather than beside it: `mv` is only atomic within one file
 * system, the target is somewhere we are already writing, and its parent may
 * be somewhere we are not allowed to write at all.
 */
export function stagingPath(target: string, id: string): string {
  return `${target.replace(/\/+$/, '')}/${stagingName(id)}`;
}

/**
 * Unpacks the archive arriving on standard input into the staging folder.
 *
 * The trap covers the signals, not the ordinary end of the command: the
 * staging folder has to outlive this and be there for the script below. A
 * connection that drops sends SIGHUP, and then it is cleared up at once.
 *
 * Anything left behind by a client that died between the two commands is
 * swept a day later, by the next upload that comes this way.
 *
 * `--no-same-owner` is said out loud because a connection that logs in as root
 * would otherwise try to give every file the uid it had on the other machine.
 */
export function unpackCommand(target: string, id: string): string {
  const staging = quote(stagingPath(target, id));
  const sweep =
    `find ${quote(target)} -maxdepth 1 -name ${quote(
      `${STAGING_PREFIX}*`
    )} -mtime +0 -exec rm -rf -- {} + 2>/dev/null;`;

  return (
    `S=${staging}; trap 'rm -rf -- "$S"' INT TERM HUP; ` +
    `${sweep} ` +
    `mkdir -p -- "$S" && COPYFILE_DISABLE=1 tar --no-same-owner -xzf - -C "$S"`
  );
}

/** One file on its way from the staging folder to where it belongs. */
export interface Promotion {
  /** Relative to the target folder, with forward slashes. */
  path: string;
  /**
   * The mode to give it if there is nothing there yet. Left out for a symlink,
   * which has no mode of its own worth setting - chmod through a link changes
   * whatever it points at.
   */
  mode?: number;
}

export interface PromoteOption {
  target: string;
  id: string;
  flavour: TarFlavour;
  /** Folders to have in place first, relative to the target. */
  directories: string[];
  files: Promotion[];
  /** Configured modes, which override everything else when they are set. */
  filePerm?: number;
  dirPerm?: number;
}

function octal(mode: number): string {
  return (mode & 0o7777).toString(8); // tslint:disable-line:no-bitwise
}

/**
 * How to give a file the mode the file it replaces already had.
 *
 * The one place the two userlands genuinely differ, and the reason the flavour
 * is worth knowing: GNU chmod can be pointed at another file, and the other
 * one has to be told in numbers by a `stat` whose flags are its own.
 */
function carryMode(flavour: TarFlavour, staged: string, target: string): string {
  return flavour === 'gnu'
    ? `chmod --reference=${target} -- ${staged}`
    : `chmod "$(stat -f '%Lp' ${target})" -- ${staged}`;
}

/**
 * The script that puts the unpacked files in place.
 *
 * `mv` within one file system is a rename, so a file is either the old one or
 * the new one and never half of either - which is what `useTempFile` has always
 * been for, and what a plain `tar -x` into the target could not give.
 *
 * Deliberately not `set -e`: file by file, one file that cannot be written is
 * one file's failure and the rest of the transfer stands, so the same holds
 * here. What does happen is that the count comes back as the exit code, and
 * anything above zero sends the whole folder round the long way - which
 * rewrites what did land, and is no worse for it.
 */
export function promoteScript(option: PromoteOption): string {
  const { target, id, flavour, directories, files, filePerm, dirPerm } = option;
  const staging = stagingPath(target, id);
  const at = (base: string, rel: string) => quote(`${base}/${rel}`);

  const lines: string[] = [
    `S=${quote(staging)}`,
    `trap 'rm -rf -- "$S"' EXIT INT TERM HUP`,
    `f=0`,
  ];

  directories.forEach(rel => {
    const dir = at(target, rel);
    lines.push(`mkdir -p -- ${dir} || f=$((f+1))`);
    if (dirPerm !== undefined) {
      lines.push(`chmod ${octal(dirPerm)} -- ${dir} 2>/dev/null`);
    }
  });

  files.forEach(({ path, mode }) => {
    const staged = at(staging, path);
    const placed = at(target, path);

    if (mode === undefined) {
      // Nothing to set, and nothing to carry over: a link is replaced whole.
    } else if (filePerm !== undefined) {
      lines.push(`chmod ${octal(filePerm)} -- ${staged} 2>/dev/null`);
    } else {
      // A file already there keeps the mode it has, and a new one is given the
      // mode of the file it came from. Which is what one transfer at a time
      // arrives at, by reading the target and carrying it over the rename.
      lines.push(
        `if [ -e ${placed} ]; then ${carryMode(
          flavour,
          staged,
          placed
        )} 2>/dev/null; else chmod ${octal(mode)} -- ${staged} 2>/dev/null; fi`
      );
    }

    lines.push(`mv -f -- ${staged} ${placed} || f=$((f+1))`);
  });

  lines.push(`rm -rf -- "$S"`);
  lines.push(`exit $f`);

  return lines.join('\n') + '\n';
}
