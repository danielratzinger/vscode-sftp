import SyncQueue, { resumed } from '../syncQueue';

/**
 * Three rules, and the third is the one that was missing: an upload that
 * failed used to be logged and forgotten, so a connection that blinked for
 * thirty seconds left those changes on this machine and said nothing.
 */

const option = { settle: 3000, cooldown: 5000 };

describe('waiting for a file to settle', () => {
  it('holds a file back until it has sat still', () => {
    const queue = new SyncQueue(option);
    queue.put('/repo/a.php', 'upload', 1000);

    expect(queue.due(2000)).toEqual([]);
    expect(queue.due(4000)).toHaveLength(1);
  });

  it('pushes the moment back when the file is written again', () => {
    const queue = new SyncQueue(option);
    queue.put('/repo/a.php', 'upload', 1000);
    queue.put('/repo/a.php', 'upload', 3000);

    expect(queue.due(4001)).toEqual([]);
    expect(queue.due(6000)).toHaveLength(1);
    // Two writes, one upload.
    expect(queue.size).toBe(1);
  });

  it('lets a delete replace an upload that had not happened yet', () => {
    const queue = new SyncQueue(option);
    queue.put('/repo/a.php', 'upload', 1000);
    queue.put('/repo/a.php', 'remove', 1500);

    expect(queue.due(9000).map(one => one.op)).toEqual(['remove']);
  });
});

describe('retrying what failed', () => {
  it('keeps a failed upload instead of dropping it', () => {
    const queue = new SyncQueue(option);
    queue.put('/repo/a.php', 'upload', 0);
    const [due] = queue.due(3000);

    queue.failed(due.file, 3000);

    expect(queue.size).toBe(1);
    expect(queue.due(3000)).toEqual([]);
    expect(queue.due(8000)).toHaveLength(1);
  });

  it('waits longer each time, up to a ceiling', () => {
    const queue = new SyncQueue({ ...option, maxCooldown: 12000 });
    queue.put('/repo/a.php', 'upload', 0);

    queue.failed('/repo/a.php', 0);
    expect(queue.all()[0].at).toBe(5000);

    queue.failed('/repo/a.php', 0);
    expect(queue.all()[0].at).toBe(10000);

    queue.failed('/repo/a.php', 0);
    expect(queue.all()[0].at).toBe(12000);

    queue.failed('/repo/a.php', 0);
    expect(queue.all()[0].at).toBe(12000);
  });

  it('counts the attempts, so what is stuck can be said', () => {
    const queue = new SyncQueue(option);
    queue.put('/repo/a.php', 'upload', 0);
    queue.put('/repo/b.php', 'upload', 0);
    queue.failed('/repo/a.php', 0);

    expect(queue.retrying().map(one => one.file)).toEqual(['/repo/a.php']);
    expect(queue.retrying()[0].tries).toBe(1);
  });

  it('does not push back a write that happened during the attempt', () => {
    // The upload of the old bytes failed, but the file has been written
    // again since. That newer write is not a failure and waits only for the
    // settle it was given.
    const queue = new SyncQueue(option);
    queue.put('/repo/a.php', 'upload', 0);
    const [attempt] = queue.due(3000);

    queue.put('/repo/a.php', 'upload', 3000); // written again mid-flight
    queue.failed('/repo/a.php', 3500, attempt);

    expect(queue.all()[0].at).toBe(6000);
    expect(queue.all()[0].tries).toBe(0);
  });

  it('forgets a file that succeeded', () => {
    const queue = new SyncQueue(option);
    queue.put('/repo/a.php', 'upload', 0);
    queue.done('/repo/a.php');

    expect(queue.size).toBe(0);
  });
});

describe('what was left over last time', () => {
  it('comes back due at once, whatever clock it was written under', () => {
    const queue = resumed(
      option,
      [
        { file: '/repo/a.php', op: 'upload', at: 1_600_000_000_000, tries: 4 },
        { file: '/repo/b.php', op: 'remove', at: 1_600_000_000_000, tries: 0 },
      ],
      500
    );

    expect(queue.due(500)).toHaveLength(2);
    expect(queue.all()[0].tries).toBe(4);
  });

  it('throws away anything that is not an operation', () => {
    const queue = resumed(
      option,
      [
        { file: '/repo/a.php', op: 'upload', at: 0, tries: 0 },
        { op: 'upload', at: 0, tries: 0 } as any,
        { file: '/repo/b.php', op: 'sing', at: 0, tries: 0 } as any,
        null as any,
      ],
      0
    );

    expect(queue.all().map(one => one.file)).toEqual(['/repo/a.php']);
  });

  it('round-trips through plain data', () => {
    const queue = new SyncQueue(option);
    queue.put('/repo/a.php', 'upload', 0);
    queue.failed('/repo/a.php', 0);

    const again = resumed(option, JSON.parse(JSON.stringify(queue)), 100);

    expect(again.all()).toEqual([
      { file: '/repo/a.php', op: 'upload', at: 100, tries: 1 },
    ]);
  });
});
