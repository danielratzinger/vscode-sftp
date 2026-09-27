/**
 * Which profile a connection should use, given what was asked for.
 *
 * One name is selected for the window, and connections need not agree about
 * what names exist: a file with two contexts can call one pair `dev1`/`prod1`
 * and the other `dev2`/`prod2`, which is what the documentation shows. Asking
 * for `dev1` then means something to one of them and nothing to the other, and
 * the one it means nothing to has no business failing over it.
 *
 * On its own here, with nothing imported, because this is a rule and the class
 * that needs it cannot be loaded without an editor around it.
 */
export interface ProfileChoice {
  /** The profile to merge, or null for the configuration as written. */
  use: string | null;
  /**
   * Set when the answer is not what was asked for, so it can be said once
   * rather than assumed.
   */
  insteadOf?: string;
}

export function profileToUse(
  wanted: string | null | undefined,
  available: string[],
  ownDefault?: string
): ProfileChoice {
  if (available.length === 0) {
    // Nothing to choose between. A name asked for elsewhere is not this
    // connection's concern.
    return { use: null };
  }

  if (!wanted) {
    return { use: null };
  }

  if (available.indexOf(wanted) !== -1) {
    return { use: wanted };
  }

  if (ownDefault && available.indexOf(ownDefault) !== -1) {
    return { use: ownDefault, insteadOf: wanted };
  }

  // It has profiles, none of them is the one asked for, and it names no default
  // of its own. The configuration as written is the only thing left that is
  // certainly meant.
  return { use: null, insteadOf: wanted };
}

/** What a watcher is told to watch, and what to do when it sees something. */
export interface WatchedFiles {
  files: false | string;
  autoUpload: boolean;
  autoDelete: boolean;
}

/**
 * The watcher a connection should have, once the chosen profile has had its say.
 *
 * `uploadOnSave` can be set per profile - the documented example does exactly
 * that - because it is read afresh on every save. The watcher could not, because
 * it is *installed* once and never looked at again, so the setting it was built
 * from was whatever the file said at the root.
 *
 * Which left the asymmetry pointing the wrong way: "upload on save only to dev"
 * was expressible and "watch and upload only to dev" was not. Switching to a
 * profile that deploys to production meant the build output started going there
 * on its own, with no save and no question.
 *
 * The whole object is overridable rather than the two useful keys, because one
 * rule explains itself and a carve-out does not. A glob per profile is of little
 * use - it describes this project's output, which does not change with the
 * server - but it costs nothing to allow.
 */
export function watcherToUse(
  root: WatchedFiles | undefined,
  fromProfile: Partial<WatchedFiles> | undefined
): WatchedFiles | undefined {
  if (!fromProfile) {
    return root;
  }

  return { ...root, ...fromProfile } as WatchedFiles;
}
