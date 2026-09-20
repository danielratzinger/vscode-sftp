import * as path from 'path';
import * as fse from 'fs-extra';

/**
 * One writer per connection, across windows as well as within one.
 *
 * Inside a window this is easy: a connection holds one chosen folder, and
 * choosing another replaces it. Between windows it is not. Two editors open on
 * the same project share the store that says what is syncing but get no word
 * when the other changes it, so both start watching - and if they are pointed
 * at different checkouts, two different sources write to one remote path and
 * the server ends up with whichever landed last.
 *
 * `autosync.sh` solves this with a pidfile. This is the same idea in the one
 * place both windows can see: a small file per connection, claimed on start,
 * touched while running, and treated as abandoned once nobody has touched it
 * for a while. A window that cannot claim it does not start, and says who has
 * it.
 *
 * Nothing here is a real lock - two windows can still race for the same file
 * in the same millisecond - and it does not need to be. What it has to catch
 * is the case that actually happens: a window left open for a week, forgotten,
 * quietly deploying an old worktree.
 */

export interface Claim {
  /** Which window holds it. */
  window: string;
  /** When it was last known to be alive. */
  at: number;
  /** What it is syncing, so the other window can say something useful. */
  root: string;
}

/** How often a holder says it is still there. */
export const KEEP_EVERY = 10 * 1000;

/** How long without a word before a claim is treated as abandoned. */
export const ABANDONED_AFTER = 40 * 1000;

function fileFor(root: string, id: string): string {
  return path.join(root, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.lock`);
}

export async function readClaim(
  root: string,
  id: string
): Promise<Claim | undefined> {
  try {
    const held = JSON.parse(await fse.readFile(fileFor(root, id), 'utf8'));
    if (held && typeof held.window === 'string' && typeof held.at === 'number') {
      return held;
    }
  } catch (error) {
    // No claim, or one written by something that is not this.
  }

  return undefined;
}

export function abandoned(held: Claim, now: number): boolean {
  // Also true of a claim from the future, which is what a clock change leaves
  // behind - and refusing to sync until the clock catches up would be worse
  // than taking it over.
  return now - held.at > ABANDONED_AFTER || held.at > now + ABANDONED_AFTER;
}

export type ClaimResult =
  | { held: true }
  | { held: false; by: Claim };

/**
 * Takes the claim, unless another window holds it and is still alive.
 *
 * `force` is what a person choosing "take it over" means: the other window
 * will notice on its next heartbeat and stand down.
 */
export async function claim(
  root: string,
  id: string,
  window: string,
  syncing: string,
  force = false,
  now: number = Date.now()
): Promise<ClaimResult> {
  const existing = await readClaim(root, id);

  if (
    existing &&
    existing.window !== window &&
    !abandoned(existing, now) &&
    !force
  ) {
    return { held: false, by: existing };
  }

  await fse.ensureDir(root);
  await fse.writeFile(
    fileFor(root, id),
    JSON.stringify({ window, at: now, root: syncing })
  );

  return { held: true };
}

/** Says this window is still here, and whether it still holds the claim. */
export async function keep(
  root: string,
  id: string,
  window: string,
  syncing: string,
  now: number = Date.now()
): Promise<boolean> {
  const existing = await readClaim(root, id);

  // Somebody took it over. Saying so is the point: the holder stands down
  // rather than both of them writing.
  if (existing && existing.window !== window) {
    return false;
  }

  await fse.ensureDir(root);
  await fse.writeFile(
    fileFor(root, id),
    JSON.stringify({ window, at: now, root: syncing })
  );

  return true;
}

export async function release(
  root: string,
  id: string,
  window: string
): Promise<void> {
  const existing = await readClaim(root, id);
  if (existing && existing.window !== window) {
    return; // Not ours to give up any more.
  }

  try {
    await fse.remove(fileFor(root, id));
  } catch (error) {
    // Gone already, or not ours to remove.
  }
}
