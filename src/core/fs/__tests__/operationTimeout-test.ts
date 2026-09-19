import {
  isOperationTimeout,
  OperationTimeoutError,
  watchCounter,
  watchForStall,
  withDeadline,
} from '../operationTimeout';

const never = () => new Promise<void>(() => undefined);
const after = (ms: number, value?: any) =>
  new Promise(resolve => setTimeout(() => resolve(value), ms));

describe('withDeadline', () => {
  it('gives up on a call that never answers', async () => {
    const error = await withDeadline(never(), {
      ms: 20,
      operation: 'list /srv/app',
    }).catch(e => e);

    expect(isOperationTimeout(error)).toBe(true);
    expect(error.message).toContain('list /srv/app');
    expect(error.message).toContain('did not answer');
  });

  it('lets a slow answer through', async () => {
    expect(await withDeadline(after(10, 'here'), { ms: 200, operation: 'stat' }))
      .toBe('here');
  });

  it('passes the real error through when the call fails first', async () => {
    const failing = Promise.reject(new Error('550 Not found'));

    const error = await withDeadline(failing, { ms: 200, operation: 'stat' })
      .catch(e => e);

    expect(error.message).toBe('550 Not found');
    expect(isOperationTimeout(error)).toBe(false);
  });

  it('retires the connection before telling the caller', async () => {
    const order: string[] = [];

    await withDeadline(never(), {
      ms: 10,
      operation: 'list',
      onExpire: () => order.push('retired'),
    }).catch(() => order.push('rejected'));

    expect(order).toEqual(['retired', 'rejected']);
  });

  it('still answers when retiring the connection throws', async () => {
    const error = await withDeadline(never(), {
      ms: 10,
      operation: 'list',
      onExpire: () => {
        throw new Error('the socket was already gone');
      },
    }).catch(e => e);

    expect(isOperationTimeout(error)).toBe(true);
  });

  it('swallows the abandoned call’s late failure', async () => {
    // An unhandled rejection takes the extension host down with it, and this
    // one belongs to a call that has already been answered.
    const unhandled: any[] = [];
    const onUnhandled = (reason: any) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const late = new Promise((resolve, reject) =>
      setTimeout(() => reject(new Error('421 Timeout')), 20)
    );

    await withDeadline(late, { ms: 5, operation: 'list' }).catch(() => undefined);
    await after(60);

    process.removeListener('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('is off when the deadline is zero or less', async () => {
    const work = after(15, 'slow');

    expect(await withDeadline(work, { ms: 0, operation: 'x' })).toBe('slow');
    expect(await withDeadline(after(15, 'also'), { ms: -1, operation: 'x' }))
      .toBe('also');
  });
});

describe('watchForStall', () => {
  it('fires when nothing moves', async () => {
    let stalled: OperationTimeoutError | undefined;
    const watchdog = watchForStall(20, 'download index.php', e => (stalled = e));

    await after(60);
    watchdog.stop();

    expect(stalled).toBeDefined();
    expect(stalled!.stalled).toBe(true);
    expect(stalled!.message).toContain('stopped making progress');
  });

  it('never fires while bytes keep moving, however long it takes', async () => {
    // The transfer this protects is a large file on a slow line: legitimate,
    // and a total deadline would abort exactly that one.
    let stalled = false;
    const watchdog = watchForStall(30, 'download big.iso', () => (stalled = true));

    for (let i = 0; i < 8; i += 1) {
      await after(10);
      watchdog.progress();
    }
    watchdog.stop();
    await after(50);

    expect(stalled).toBe(false);
  });

  it('fires once, not once per tick', async () => {
    let fired = 0;
    const watchdog = watchForStall(10, 'upload', () => (fired += 1));

    await after(60);
    watchdog.progress();
    await after(40);
    watchdog.stop();

    expect(fired).toBe(1);
  });

  it('says nothing after it has been stopped', async () => {
    let fired = false;
    const watchdog = watchForStall(20, 'upload', () => (fired = true));

    watchdog.stop();
    await after(60);

    expect(fired).toBe(false);
  });

  it('is off when the interval is zero', async () => {
    let fired = false;
    watchForStall(0, 'upload', () => (fired = true)).progress();

    await after(30);
    expect(fired).toBe(false);
  });
});

describe('watchCounter', () => {
  it('does nothing at all when there is no counter to read', async () => {
    // A transfer whose progress cannot be measured is left alone rather than
    // abandoned on a guess.
    let fired = false;
    const watchdog = watchCounter(() => undefined, 20, 'upload', () => (fired = true));

    await after(60);
    watchdog.stop();

    expect(fired).toBe(false);
  });

  it('gives up on a transfer whose counter stops moving', async () => {
    const bytes = 4096;
    let stalled: OperationTimeoutError | undefined;
    const watchdog = watchCounter(() => bytes, 1200, 'download big.iso', e => (stalled = e));

    await after(2000);
    watchdog.stop();

    expect(stalled).toBeDefined();
    expect(stalled!.stalled).toBe(true);
    expect(bytes).toBe(4096);
  });

  it('keeps a slow transfer alive as long as bytes move', async () => {
    let bytes = 0;
    let fired = false;
    const watchdog = watchCounter(() => bytes, 1200, 'download big.iso', () => (fired = true));

    // Slower than the watchdog interval, but never silent.
    for (let i = 0; i < 4; i += 1) {
      await after(500);
      bytes += 1;
    }
    await after(300);
    watchdog.stop();

    expect(fired).toBe(false);
  });
});
