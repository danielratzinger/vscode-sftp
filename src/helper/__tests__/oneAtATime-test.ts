import { createGate } from '../oneAtATime';

const later = () => {
  let release: (value?: any) => void = () => undefined;
  const waited = new Promise(done => {
    release = done;
  });
  return { waited, release: () => release() };
};

describe('one at a time, per key', () => {
  it('does not run a second time while the first is still going', async () => {
    const gate = createGate();
    const first = later();
    let ran = 0;

    const one = gate.hold('a', async () => {
      ran += 1;
      await first.waited;
      return 'first';
    });

    expect(await gate.hold('a', async () => {
      ran += 1;
      return 'second';
    })).toBeUndefined();

    expect(ran).toBe(1);

    first.release();
    expect(await one).toBe('first');
  });

  it('holds each key on its own', async () => {
    const gate = createGate();
    const held = later();

    const one = gate.hold('a', async () => {
      await held.waited;
      return 'a';
    });

    expect(await gate.hold('b', async () => 'b')).toBe('b');

    held.release();
    await one;
  });

  it('frees the key once the work is done, so the next may ask', async () => {
    const gate = createGate();

    expect(await gate.hold('a', async () => 'once')).toBe('once');
    expect(gate.holding('a')).toBe(false);
    expect(await gate.hold('a', async () => 'again')).toBe('again');
  });

  it('frees the key when the work throws, and lets the failure through', async () => {
    const gate = createGate();

    await expect(
      gate.hold('a', async () => {
        throw new Error('no');
      })
    ).rejects.toThrow('no');

    expect(gate.holding('a')).toBe(false);
    expect(await gate.hold('a', async () => 'after')).toBe('after');
  });

  it('says which keys are busy, for skipping the preparation too', async () => {
    const gate = createGate();
    const held = later();

    const one = gate.hold('a', async () => {
      await held.waited;
    });

    expect(gate.holding('a')).toBe(true);
    expect(gate.holding('b')).toBe(false);

    held.release();
    await one;
    expect(gate.holding('a')).toBe(false);
  });
});
