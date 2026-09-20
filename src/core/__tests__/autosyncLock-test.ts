jest.mock('fs');

import { vol } from 'memfs';
import {
  ABANDONED_AFTER,
  abandoned,
  claim,
  keep,
  readClaim,
  release,
} from '../autosyncLock';

/**
 * The case this exists for is not two windows racing in the same millisecond.
 * It is a window left open for a week, forgotten, quietly deploying an old
 * worktree while you work in another one.
 */

beforeEach(() => vol.reset());

const root = '/locks';
const id = 'conn-abc123';

describe('taking the claim', () => {
  it('is given to the first window that asks', async () => {
    expect(await claim(root, id, 'window-a', '/work/main', false, 1000)).toEqual({
      held: true,
    });

    expect(await readClaim(root, id)).toEqual({
      window: 'window-a',
      at: 1000,
      root: '/work/main',
    });
  });

  it('is refused to a second window while the first is alive', async () => {
    await claim(root, id, 'window-a', '/work/main', false, 1000);

    const second = await claim(root, id, 'window-b', '/work/branch', false, 2000);

    expect(second.held).toBe(false);
    expect((second as any).by.window).toBe('window-a');
    // What the other window is syncing, so this one can say something useful.
    expect((second as any).by.root).toBe('/work/main');
  });

  it('is given again to the window that already holds it', async () => {
    await claim(root, id, 'window-a', '/work/main', false, 1000);

    expect(await claim(root, id, 'window-a', '/work/other', false, 2000)).toEqual({
      held: true,
    });
  });

  it('is taken over when the holder has gone quiet', async () => {
    await claim(root, id, 'window-a', '/work/main', false, 1000);

    const later = 1000 + ABANDONED_AFTER + 1;
    expect(await claim(root, id, 'window-b', '/work/branch', false, later)).toEqual(
      { held: true }
    );
  });

  it('is taken over on purpose when somebody says to', async () => {
    await claim(root, id, 'window-a', '/work/main', false, 1000);

    expect(await claim(root, id, 'window-b', '/work/branch', true, 1500)).toEqual({
      held: true,
    });
    expect((await readClaim(root, id))!.window).toBe('window-b');
  });

  it('does not confuse one connection with another', async () => {
    await claim(root, id, 'window-a', '/work/main', false, 1000);

    expect(await claim(root, 'conn-other', 'window-b', '/x', false, 1000)).toEqual({
      held: true,
    });
  });
});

describe('deciding a claim has been abandoned', () => {
  it('is true once nobody has said anything for long enough', () => {
    const held = { window: 'a', at: 1000, root: '/x' };

    expect(abandoned(held, 1000 + ABANDONED_AFTER - 1)).toBe(false);
    expect(abandoned(held, 1000 + ABANDONED_AFTER + 1)).toBe(true);
  });

  it('is true of a claim from the future, which is what a clock change leaves', () => {
    // Refusing to sync until the clock catches up would be worse than taking
    // it over.
    const held = { window: 'a', at: 10_000_000, root: '/x' };

    expect(abandoned(held, 1000)).toBe(true);
  });
});

describe('keeping and giving up a claim', () => {
  it('moves the claim forward while the window is alive', async () => {
    await claim(root, id, 'window-a', '/work/main', false, 1000);

    expect(await keep(root, id, 'window-a', '/work/main', 5000)).toBe(true);
    expect((await readClaim(root, id))!.at).toBe(5000);
  });

  it('tells a holder that has been taken over to stand down', async () => {
    await claim(root, id, 'window-a', '/work/main', false, 1000);
    await claim(root, id, 'window-b', '/work/branch', true, 1500);

    expect(await keep(root, id, 'window-a', '/work/main', 2000)).toBe(false);
    // And has not stamped over the new holder on the way out.
    expect((await readClaim(root, id))!.window).toBe('window-b');
  });

  it('gives up only what it holds', async () => {
    await claim(root, id, 'window-a', '/work/main', false, 1000);
    await release(root, id, 'window-b');

    expect(await readClaim(root, id)).toBeDefined();

    await release(root, id, 'window-a');
    expect(await readClaim(root, id)).toBeUndefined();
  });

  it('claims freely once the previous holder gave it up', async () => {
    await claim(root, id, 'window-a', '/work/main', false, 1000);
    await release(root, id, 'window-a');

    expect(await claim(root, id, 'window-b', '/work/branch', false, 1100)).toEqual({
      held: true,
    });
  });

  it('is not fooled by a file that is not a claim', async () => {
    vol.fromJSON({ [`${root}/conn-abc123.lock`]: 'not json at all' });

    expect(await readClaim(root, id)).toBeUndefined();
    expect(await claim(root, id, 'window-b', '/x', false, 1000)).toEqual({
      held: true,
    });
  });
});
