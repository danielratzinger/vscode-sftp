import * as fse from 'fs-extra';
import * as path from 'path';
import { Session, storedAt } from './remoteBackup';
import { Backup } from './overwriteBackup';

/**
 * Every copy of one file the extension has kept, from both stores.
 *
 * Two places keep earlier versions, for two different reasons: autosync keeps
 * what the server had before it first wrote over a file in a session, and a
 * download keeps what was here before it wrote over the local copy. Looking for
 * a file's history means looking in both, so this asks both.
 */

export interface KeptCopy {
  /** Where the copy is on this machine. */
  path: string;
  when: number;
  /** Whose copy: the server's before autosync, or this machine's before a download. */
  kind: 'server' | 'local';
}

export async function copiesOf(option: {
  /** Root of the server store and the connection's key in it. */
  remoteRoot: string;
  connectionId: string;
  sessions: Session[];
  remotePath: string;
  /** What the download store holds for the file here. */
  replaced: Backup[];
}): Promise<KeptCopy[]> {
  const copies: KeptCopy[] = [];

  for (const session of option.sessions) {
    const file = storedAt(
      { root: option.remoteRoot, connectionId: option.connectionId } as any,
      session.stamp,
      option.remotePath
    );
    if (await fse.pathExists(file)) {
      copies.push({ path: file, when: session.when, kind: 'server' });
    }
  }

  option.replaced.forEach(one =>
    copies.push({ path: one.path, when: one.timestamp, kind: 'local' })
  );

  return copies.sort((a, b) => b.when - a.when);
}

/**
 * Where to look when there is no copy of the file itself: the connection's
 * folder in whichever store has one, the server's first, since that is the one
 * autosync fills. Undefined when neither has anything for it.
 */
export async function connectionFolder(
  stores: Array<{ root: string; connectionId: string }>
): Promise<string | undefined> {
  for (const store of stores) {
    const folder = path.join(store.root, store.connectionId);
    if (store.root && (await fse.pathExists(folder))) {
      return folder;
    }
  }

  return undefined;
}
