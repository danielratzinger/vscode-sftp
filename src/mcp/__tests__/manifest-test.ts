import { DEFAULT_WALK } from '../search';
import {
  forget,
  keyFor,
  nextOffset,
  offsetOf,
  recall,
  remember,
} from '../manifest';

const result = (paths: string[]) => ({
  files: paths.map(path => ({ path, size: 1, mtime: 0 })),
  truncated: false,
  stoppedBy: [],
  depth: 1,
  directories: 1,
});

describe('the remembered manifest', () => {
  beforeEach(() => forget());

  it('gives back what a walk found', () => {
    const key = keyFor('1', '/srv/app', DEFAULT_WALK);
    remember(key, result(['/srv/app/a.php']));

    expect(recall(key)!.files.map(f => f.path)).toEqual(['/srv/app/a.php']);
  });

  it('forgets one that has gone stale', () => {
    // Held only long enough to continue a listing; after that the server has
    // had time to change and a fresh walk is the honest answer.
    const key = keyFor('1', '/srv/app', DEFAULT_WALK);
    remember(key, result(['/srv/app/a.php']), 1000);

    expect(recall(key, 1000 + 119 * 1000)).toBeDefined();
    expect(recall(key, 1000 + 121 * 1000)).toBeUndefined();
    // And drops it rather than keeping it around.
    expect(recall(key, 1000)).toBeUndefined();
  });

  it('keeps the connection, the root and the limits apart', () => {
    const a = keyFor('1', '/srv/app', DEFAULT_WALK);

    expect(keyFor('2', '/srv/app', DEFAULT_WALK)).not.toBe(a);
    expect(keyFor('1', '/srv/other', DEFAULT_WALK)).not.toBe(a);
    expect(keyFor('1', '/srv/app', { ...DEFAULT_WALK, maxDepth: 2 })).not.toBe(a);
    expect(
      keyFor('1', '/srv/app', { ...DEFAULT_WALK, excludeFolders: ['vendor'] })
    ).not.toBe(a);
  });

  it('does not grow without limit', () => {
    for (let i = 0; i < 25; i += 1) {
      remember(`key-${i}`, result([`/srv/${i}.php`]), 1000 + i);
    }

    // The oldest went; the newest stayed.
    expect(recall('key-0', 1030)).toBeUndefined();
    expect(recall('key-24', 1030)).toBeDefined();
  });
});

describe('nextOffset', () => {
  it('points at the first thing left out', () => {
    expect(nextOffset(1500, 0, 1000)).toBe(1000);
    expect(nextOffset(1500, 1000, 500)).toBeUndefined();
    expect(nextOffset(3, 0, 3)).toBeUndefined();
    expect(nextOffset(0, 0, 0)).toBeUndefined();
  });
});

describe('offsetOf', () => {
  it('takes what a client sends and makes it usable', () => {
    expect(offsetOf(10, 100)).toBe(10);
    expect(offsetOf('10', 100)).toBe(10);
    expect(offsetOf(10.7, 100)).toBe(10);
    expect(offsetOf(500, 100)).toBe(100);
  });

  it('treats nonsense as the beginning', () => {
    [undefined, null, '', 'lots', {}, -5, NaN].forEach(value =>
      expect(offsetOf(value, 100)).toBe(0)
    );
  });
});
