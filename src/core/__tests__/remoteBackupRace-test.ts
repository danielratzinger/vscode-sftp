import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { keepRemote, sessionsOf, storedAt } from '../remoteBackup';

/**
 * Two requests for the same file at once, on the real file system: the rule
 * that the first copy stays rests on the system refusing to create a file
 * that already exists, which the in-memory one used elsewhere does not do.
 */

let root: string;
const STAMP = '2026-10-11-225540';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-race-'));
});

afterEach(() => fse.removeSync(root));

const bytes = (text: string, wait = 0) => async () => {
  await new Promise(resolve => setTimeout(resolve, wait));
  return { kind: 'bytes' as const, bytes: Buffer.from(text) };
};

it('keeps one copy, the first written, when two ask at once', async () => {
  const option = { root, connectionId: '_httpdocs_site@host', maxAgeDays: 30 };

  const results = await Promise.all([
    keepRemote(option, STAMP, '/httpdocs/a.php', bytes('before')),
    keepRemote(option, STAMP, '/httpdocs/a.php', bytes('after the upload', 20)),
  ]);

  expect(results).toEqual(['kept', 'kept']);
  expect(fs.readFileSync(storedAt(option, STAMP, '/httpdocs/a.php'), 'utf8')).toBe('before');

  const [session] = await sessionsOf(option);
  expect(session.files).toBe(1);
});
