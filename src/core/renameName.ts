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
