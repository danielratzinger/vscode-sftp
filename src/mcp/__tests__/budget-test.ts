import { createBudget, CallTimeoutError, UNLIMITED, withBudget } from '../budget';

describe('createBudget', () => {
  it('is spent when the time has gone', () => {
    let now = 1000;
    const budget = createBudget(50, () => now);

    expect(budget.spent()).toBe(false);
    expect(budget.remaining()).toBe(50);

    now = 1049;
    expect(budget.spent()).toBe(false);

    now = 1050;
    expect(budget.spent()).toBe(true);
    expect(budget.remaining()).toBe(0);
  });

  it('is unlimited when there is no ceiling', () => {
    expect(createBudget(0)).toBe(UNLIMITED);
    expect(createBudget(-1).spent()).toBe(false);
    expect(UNLIMITED.remaining()).toBe(Infinity);
  });
});

describe('withBudget', () => {
  const never = () => new Promise<void>(() => undefined);

  it('stops a call that runs past its budget', async () => {
    const error = await withBudget(never(), 20, 'sftp_search').catch(e => e);

    expect(error).toBeInstanceOf(CallTimeoutError);
    expect(error.message).toContain('sftp_search');
    // The model needs to know what to do differently, not just that it failed.
    expect(error.message).toContain('Ask for less');
  });

  it('leaves a call that finishes in time alone', async () => {
    const work = new Promise(resolve => setTimeout(() => resolve('done'), 5));

    expect(await withBudget(work, 200, 'sftp_list')).toBe('done');
  });

  it('passes a real failure through unchanged', async () => {
    const failing = Promise.reject(new Error('Unknown server.'));

    const error = await withBudget(failing, 200, 'sftp_list').catch(e => e);

    expect(error.message).toBe('Unknown server.');
  });

  it('swallows the abandoned call’s late failure', async () => {
    const unhandled: any[] = [];
    const onUnhandled = (reason: any) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const late = new Promise((resolve, reject) =>
      setTimeout(() => reject(new Error('too late')), 20)
    );

    await withBudget(late, 5, 'sftp_search').catch(() => undefined);
    await new Promise(done => setTimeout(done, 60));

    process.removeListener('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('is off when there is no budget', async () => {
    const work = new Promise(resolve => setTimeout(() => resolve('slow'), 20));

    expect(await withBudget(work, 0, 'sftp_list')).toBe('slow');
  });
});
