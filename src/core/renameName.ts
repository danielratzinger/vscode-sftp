/**
 * What is wrong with a name somebody typed for a rename, or nothing when it
 * will do.
 *
 * A rename changes what a file is called and not where it lives, so a separator
 * is refused rather than quietly making a move out of it, and `.` and `..` name
 * a folder rather than a file in one.
 *
 * On its own here, with nothing imported, because the handler that uses it sits
 * inside a cycle of modules that cannot be loaded without an editor around them
 * - and a rule about names should be testable without one.
 */
export function nameComplaint(name: string): string | null {
  const trimmed = name.trim();

  if (trimmed === '') {
    return 'A name is needed.';
  }

  if (/[\\/]/.test(trimmed)) {
    return 'A name cannot hold a slash. Renaming does not move a file.';
  }

  if (trimmed === '.' || trimmed === '..') {
    return `'${trimmed}' names a folder, not a file in one.`;
  }

  // tslint:disable-next-line:no-control-regex
  if (/[\u0000-\u001f]/.test(trimmed)) {
    return 'A name cannot hold control characters.';
  }

  return null;
}

/** What is already sitting at the name somebody wants to use. */
export type Occupant = 'nothing' | 'file' | 'directory';

export interface Clash {
  /** What is at the new name on the server. */
  remote: Occupant;
  /** What is at the new name on this machine. */
  local: Occupant;
}

export interface Choice {
  /** Rename on the server as well as here. */
  overwrite: boolean;
  renameLocal: boolean;
}

export interface Ask {
  /** Nothing to ask: go ahead with this. */
  goAhead?: Choice;
  /** Nothing to ask and nothing to do: say this and stop. */
  refuse?: string;
  /** Put this to the person, with these answers. */
  message?: string;
  choices?: string[];
  /** What each answer means. */
  meaning?: { [answer: string]: Choice };
}

export const OVERWRITE = 'Overwrite';
export const OVERWRITE_BOTH = 'Overwrite Both';
export const SERVER_ONLY = 'Only on the Server';
export const CANCEL = 'Cancel';

/**
 * What to do about a name that is already taken.
 *
 * A folder in the way is refused rather than offered as something to overwrite:
 * overwriting one means deleting whatever is inside it, and nobody typing a new
 * name is asking for that. A file in the way is a fair question, and which
 * question depends on which side it is on - the copy here can be left under its
 * old name, and the one on the server cannot.
 */
export function whatToAsk(clash: Clash, name: string): Ask {
  const inTheWay = (where: string, what: string) =>
    `A ${what} called '${name}' is already ${where}.`;

  if (clash.remote === 'directory' || clash.local === 'directory') {
    const where = clash.remote === 'directory' ? 'on the server' : 'on this machine';
    return {
      refuse:
        `${inTheWay(where, 'folder')} Renaming over a folder would mean ` +
        `deleting what is inside it, so nothing was changed.`,
    };
  }

  if (clash.remote === 'nothing' && clash.local === 'nothing') {
    return { goAhead: { overwrite: false, renameLocal: true } };
  }

  if (clash.remote === 'file' && clash.local === 'file') {
    return {
      message: `${inTheWay('on the server and on this machine', 'file')} Overwrite both?`,
      choices: [OVERWRITE_BOTH, CANCEL],
      meaning: { [OVERWRITE_BOTH]: { overwrite: true, renameLocal: true } },
    };
  }

  if (clash.remote === 'file') {
    return {
      message: `${inTheWay('on the server', 'file')} Overwrite it?`,
      choices: [OVERWRITE, CANCEL],
      meaning: { [OVERWRITE]: { overwrite: true, renameLocal: true } },
    };
  }

  // Only the copy here is in the way, so the rename on the server can go ahead
  // either way - the question is only what happens to this machine's copy.
  return {
    message:
      `${inTheWay('on this machine', 'file')} Overwrite it, or rename only on ` +
      `the server and leave it alone?`,
    choices: [OVERWRITE, SERVER_ONLY, CANCEL],
    meaning: {
      [OVERWRITE]: { overwrite: true, renameLocal: true },
      [SERVER_ONLY]: { overwrite: false, renameLocal: false },
    },
  };
}

/**
 * The path a rename produces: the same folder, a new last part.
 *
 * Posix throughout, because it is a path on a server whatever this machine uses
 * for its own. Kept apart from the editor's `Uri` because that was where this
 * went wrong once: a remote uri carries the server's path in its query string
 * and only a display copy in `uri.path`, so changing the obvious one left the
 * real one pointing at the file being renamed - and then the two sides of the
 * rename were the same path.
 */
export function renamedPath(current: string, name: string): string {
  const trimmed = current.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  const folder = cut <= 0 ? trimmed.slice(0, cut + 1) : trimmed.slice(0, cut);

  return `${folder}/${name.trim()}`.replace(/\/{2,}/g, '/');
}

/** Enough of a file to tell whether two of them are the same one. */
export interface Sameness {
  size: number;
  mtime: number;
}

/**
 * Whether what is in the way is the very thing being put there.
 *
 * Then there is nothing to ask: overwriting it changes nothing and loses
 * nothing. It happens more than it sounds - the same file downloaded twice, a
 * copy made by hand under the name now being asked for.
 *
 * Compared by size and timestamp to the second, which is what every other
 * comparison in this extension uses, and for the same reason: reading both files
 * to be sure would cost a transfer to answer a question about whether to
 * transfer.
 */
export function isSameFile(a?: Sameness | null, b?: Sameness | null): boolean {
  if (!a || !b) {
    return false;
  }

  return (
    a.size === b.size &&
    Math.floor(a.mtime / 1000) === Math.floor(b.mtime / 1000)
  );
}

/** What is known about a rename made on this machine. */
export interface RenameHere {
  /** Whether the file belongs to a configured connection at all. */
  hasConnection: boolean;
  /** Whether autosync is writing that connection. */
  autosyncing: boolean;
  /** Whether the connection's own rules exclude it. */
  ignored: boolean;
  /** What is at the old name on the server. */
  onServer: Occupant;
}

/**
 * Whether a rename made here is worth putting to somebody for the server.
 *
 * Every no has a reason worth keeping separate from the others, because a
 * question asked when the answer cannot matter is worse than no question: it
 * teaches people to dismiss the next one without reading it.
 */
export function worthPassingOn(
  facts: RenameHere
): { ask: boolean; because?: string } {
  if (!facts.hasConnection) {
    return { ask: false, because: 'no connection covers it' };
  }

  if (facts.autosyncing) {
    // Autosync passes on what leaves the branch by itself, and would undo this.
    return { ask: false, because: 'autosync is writing that connection' };
  }

  if (facts.ignored) {
    return { ask: false, because: 'the connection ignores it' };
  }

  if (facts.onServer === 'nothing') {
    // A file the server has never seen is not a rename there, it is nothing -
    // and asking would make every rename in a new folder a question.
    return { ask: false, because: 'it is not on the server' };
  }

  return { ask: true };
}

/** What to do about a rename made on this machine. */
export type Following = 'ask' | 'always' | 'off';

/**
 * The setting, read so that only a value that says so means writing to a server.
 *
 * Anything unrecognised - a typo, a value from a newer version, a `true` somebody
 * expected to work - comes back as `ask`. The other two directions are worse to
 * guess at: `off` would quietly stop passing renames on, and `always` would write
 * to a server because a setting was misspelt.
 */
export function followingFromSetting(value: string | undefined | null): Following {
  return value === 'always' || value === 'off' ? value : 'ask';
}
