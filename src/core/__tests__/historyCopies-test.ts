import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { stampFor, storedAt } from '../remoteBackup';
import { connectionFolder, copiesOf } from '../historyCopies';

let root: string;
const ID = '_httpdocs_site@host';
const FILE = '/httpdocs/site/includes/App.php';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-'));
});

afterEach(() => fse.removeSync(root));

/** A copy autosync kept in the session that started at `when`. */
function keptBy(when: Date, remotePath = FILE) {
  const stamp = stampFor(when);
  const file = storedAt({ root, connectionId: ID } as any, stamp, remotePath);
  fse.outputFileSync(file, 'server');
  return { stamp, when: when.getTime(), files: 1, file };
}

describe('the copies of one file', () => {
  it('finds the server copies, newest first', async () => {
    const early = keptBy(new Date(2026, 9, 1, 9, 0, 0));
    const late = keptBy(new Date(2026, 9, 14, 11, 1, 18));

    const copies = await copiesOf({
      remoteRoot: root,
      connectionId: ID,
      sessions: [early, late],
      remotePath: FILE,
      replaced: [],
    });

    expect(copies.map(one => one.path)).toEqual([late.file, early.file]);
    expect(copies.every(one => one.kind === 'server')).toBe(true);
  });

  // A session kept other files, not this one.
  it('leaves out a session that did not keep this file', async () => {
    const other = keptBy(new Date(2026, 9, 2), '/httpdocs/site/index.php');

    expect(
      await copiesOf({
        remoteRoot: root,
        connectionId: ID,
        sessions: [other],
        remotePath: FILE,
        replaced: [],
      })
    ).toEqual([]);
  });

  it('puts the copies a download kept among them, by time', async () => {
    const session = keptBy(new Date(2026, 9, 10));
    const downloaded = {
      id: '1',
      path: '/kept/App.php/1760000000000.php',
      localPath: '/work/site/includes/App.php',
      timestamp: new Date(2026, 9, 12).getTime(),
      size: 3,
    };

    const copies = await copiesOf({
      remoteRoot: root,
      connectionId: ID,
      sessions: [session],
      remotePath: FILE,
      replaced: [downloaded],
    });

    expect(copies.map(one => one.kind)).toEqual(['local', 'server']);
  });
});

describe('where to look when the file has no copies', () => {
  it('is the connection’s folder in the store that has one', async () => {
    fse.ensureDirSync(path.join(root, 'replaced', ID));

    expect(
      await connectionFolder([
        { root: path.join(root, 'remote-backups'), connectionId: ID },
        { root: path.join(root, 'replaced'), connectionId: ID },
      ])
    ).toBe(path.join(root, 'replaced', ID));
  });

  it('is nothing when no store has anything for it', async () => {
    expect(await connectionFolder([{ root, connectionId: ID }])).toBeUndefined();
  });
});
