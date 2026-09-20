jest.mock('fs');

import { vol } from 'memfs';
import * as path from 'path';
import {
  keepRemote,
  mirrored,
  pruneRemoteBackups,
  restorePoints,
  sessionsOf,
  stampFor,
  storedAt,
  whenOf,
} from '../remoteBackup';

/**
 * By the time a bad continuous deploy is noticed, the only copy of what the
 * server had is under the thing that replaced it. These are the rules that
 * make it recoverable.
 */

beforeEach(() => vol.reset());

const option = {
  root: '/store',
  connectionId: '_httpdocs_site@example.com',
  maxAgeDays: 30,
};

const bytes = (text: string) =>
  async () => ({ kind: 'bytes' as const, bytes: Buffer.from(text) });
const absent = async () => ({ kind: 'absent' as const });
const failed = async () => ({ kind: 'failed' as const, error: new Error('timed out') });

describe('naming a moment', () => {
  it('reads and sorts the same way', () => {
    const stamp = stampFor(new Date(2026, 8, 21, 14, 30, 5));

    expect(stamp).toBe('2026-09-21-143005');
    expect(whenOf(stamp)).toBe(new Date(2026, 8, 21, 14, 30, 5).getTime());
  });

  it('says nothing about something that is not a stamp', () => {
    expect(whenOf('files')).toBeNaN();
    expect(whenOf('_manifest.jsonl')).toBeNaN();
  });
});

describe('a remote path kept as a local one', () => {
  it('mirrors it, so a person can read the folder', () => {
    expect(mirrored('/httpdocs/site/index.php')).toBe(
      path.join('httpdocs', 'site', 'index.php')
    );
  });

  it('refuses anything that would climb out of the session', () => {
    expect(mirrored('/a/../../../etc/passwd')).toBe(
      path.join('a', 'etc', 'passwd')
    );
  });
});

describe('keeping what the server had', () => {
  it('keeps the bytes and can say where they went', async () => {
    const result = await keepRemote(option, '2026-09-21-100000', '/httpdocs/a.php', bytes('old'));

    expect(result).toBe('kept');
    expect(
      vol.readFileSync(storedAt(option, '2026-09-21-100000', '/httpdocs/a.php'), 'utf8')
    ).toBe('old');
  });

  it('records a file that was not there as absent, not as nothing', async () => {
    // "It did not exist" is a state to put back too.
    const result = await keepRemote(option, '2026-09-21-100000', '/httpdocs/new.php', absent);

    expect(result).toBe('absent');
    expect(await restorePoints(option, '2026-09-21-100000')).toEqual([
      { remotePath: '/httpdocs/new.php', stamp: '2026-09-21-100000', absent: true },
    ]);
  });

  it('keeps nothing when the server could not be reached', async () => {
    // The case where an overwrite would destroy the only copy.
    const result = await keepRemote(option, '2026-09-21-100000', '/httpdocs/a.php', failed);

    expect(result).toBe('failed');
    expect(await sessionsOf(option)).toEqual([]);
  });
});

describe('putting the server back', () => {
  async function twoSessions() {
    await keepRemote(option, '2026-09-20-090000', '/httpdocs/a.php', bytes('monday a'));
    await keepRemote(option, '2026-09-20-090000', '/httpdocs/b.php', bytes('monday b'));
    await keepRemote(option, '2026-09-21-090000', '/httpdocs/a.php', bytes('tuesday a'));
    await keepRemote(option, '2026-09-21-090000', '/httpdocs/c.php', bytes('tuesday c'));
  }

  it('takes the earliest snapshot of each file from that moment on', async () => {
    await twoSessions();

    // From Monday: a.php as it was on Monday, not as it was on Tuesday.
    expect(await restorePoints(option, '2026-09-20-090000')).toEqual([
      { remotePath: '/httpdocs/a.php', stamp: '2026-09-20-090000', absent: false },
      { remotePath: '/httpdocs/b.php', stamp: '2026-09-20-090000', absent: false },
      { remotePath: '/httpdocs/c.php', stamp: '2026-09-21-090000', absent: false },
    ]);
  });

  it('leaves out what was only touched before the chosen moment', async () => {
    await twoSessions();

    expect(
      (await restorePoints(option, '2026-09-21-090000')).map(one => one.remotePath)
    ).toEqual(['/httpdocs/a.php', '/httpdocs/c.php']);
  });

  it('lists the sessions newest first, with what each holds', async () => {
    await twoSessions();

    expect(await sessionsOf(option)).toEqual([
      { stamp: '2026-09-21-090000', when: whenOf('2026-09-21-090000'), files: 2 },
      { stamp: '2026-09-20-090000', when: whenOf('2026-09-20-090000'), files: 2 },
    ]);
  });

  it('survives a manifest whose last line was never finished', async () => {
    await keepRemote(option, '2026-09-21-090000', '/httpdocs/a.php', bytes('x'));
    vol.appendFileSync(
      '/store/_httpdocs_site@example.com/2026-09-21-090000/_manifest.jsonl',
      '{"p":"/httpdocs/b.p'
    );

    expect(
      (await restorePoints(option, '2026-09-21-090000')).map(one => one.remotePath)
    ).toEqual(['/httpdocs/a.php']);
  });
});

describe('sweeping what is too old', () => {
  it('removes sessions past their age and leaves the rest', async () => {
    const now = new Date(2026, 8, 21, 12, 0, 0).getTime();
    await keepRemote(option, stampFor(new Date(now - 40 * 86400000)), '/httpdocs/a.php', bytes('old'));
    await keepRemote(option, stampFor(new Date(now - 2 * 86400000)), '/httpdocs/b.php', bytes('recent'));

    const swept = await pruneRemoteBackups(option, now);

    expect(swept.removed).toHaveLength(1);
    expect(swept.bytesFreed).toBeGreaterThan(0);
    expect(await sessionsOf(option)).toHaveLength(1);
  });

  it('takes a whole session or none of it', async () => {
    // Half a session is not the thing it says it is: a restore from it would
    // quietly put back less than it claims.
    const now = new Date(2026, 8, 21, 12, 0, 0).getTime();
    const old = stampFor(new Date(now - 40 * 86400000));
    await keepRemote(option, old, '/httpdocs/a.php', bytes('a'));
    await keepRemote(option, old, '/httpdocs/b.php', bytes('b'));

    await pruneRemoteBackups(option, now);

    expect(vol.existsSync(`/store/${option.connectionId}/${old}`)).toBe(false);
  });

  it('does nothing when there is nothing kept', async () => {
    expect(await pruneRemoteBackups(option, Date.now())).toEqual({
      removed: [],
      bytesFreed: 0,
    });
  });
});
