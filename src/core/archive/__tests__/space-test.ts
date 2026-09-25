import { roomFor } from '../space';

const MB = 1024 * 1024;
const free = (bytes: number | undefined) => () => Promise.resolve(bytes);

describe('whether what is coming will fit', () => {
  it('says yes when there is room, with a margin left over', async () => {
    await expect(roomFor(100 * MB, '/local', free(200 * MB))).resolves.toEqual({
      fits: true,
    });
  });

  it('says no when it would only just fit', async () => {
    // A tenth is kept back: a folder landing in the last free byte leaves a
    // machine that cannot save a file.
    const room = await roomFor(100 * MB, '/local', free(105 * MB));

    expect(room.fits).toBe(false);
    expect(room.because).toContain('100 MB');
    expect(room.because).toContain('105 MB');
  });

  it('says yes when nobody knows how much is coming', async () => {
    await expect(roomFor(undefined, '/local', free(1))).resolves.toEqual({
      fits: true,
    });
  });

  it('says yes when nobody knows how much room there is', async () => {
    // Refusing a transfer over a question that could not be answered is worse
    // than the thing it guards against.
    await expect(
      roomFor(100 * MB, '/local', free(undefined))
    ).resolves.toEqual({ fits: true });
  });
});
