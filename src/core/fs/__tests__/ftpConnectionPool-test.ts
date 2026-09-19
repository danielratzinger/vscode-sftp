import ConnectionPool from '../ftpConnectionPool';

interface Conn {
  name: string;
}

function createPool(limit: number, connect?: () => Promise<Conn>) {
  const primary: Conn = { name: 'primary' };
  const disconnected: Conn[] = [];
  let opened = 0;

  const pool = new ConnectionPool<Conn>(primary, {
    limit,
    connect:
      connect ||
      (() => {
        opened += 1;
        return Promise.resolve({ name: `extra-${opened}` });
      }),
    disconnect: client => {
      disconnected.push(client);
    },
  });

  return {
    pool,
    primary,
    disconnected,
    get opened() {
      return opened;
    },
  };
}

describe('ConnectionPool', () => {
  it('hands out the connection it was given before opening any', async () => {
    const { pool, primary, opened } = createPool(4);

    const lease = await pool.acquire();

    expect(lease.client).toBe(primary);
    expect(opened).toBe(0);
  });

  it('opens another connection when one is already busy', async () => {
    const ctx = createPool(4);

    const first = await ctx.pool.acquire();
    const second = await ctx.pool.acquire();

    expect(first.client).toBe(ctx.primary);
    expect(second.client).not.toBe(ctx.primary);
    expect(ctx.pool.size).toBe(2);
  });

  it('stops at the limit and queues the rest', async () => {
    const ctx = createPool(2);

    const first = await ctx.pool.acquire();
    const second = await ctx.pool.acquire();

    let third: any;
    const pending = ctx.pool.acquire().then(lease => (third = lease));
    await Promise.resolve();
    expect(third).toBeUndefined();
    expect(ctx.pool.size).toBe(2);

    ctx.pool.release(first);
    await pending;
    expect(third.client).toBe(ctx.primary);
    expect(ctx.opened).toBe(1);

    ctx.pool.release(second);
    ctx.pool.release(third);
  });

  it('gives up growing once the server refuses, and keeps working', async () => {
    let attempts = 0;
    const ctx = createPool(4, () => {
      attempts += 1;
      return Promise.reject(new Error('421 Too many connections'));
    });

    const first = await ctx.pool.acquire();

    let second: any;
    const pending = ctx.pool.acquire().then(lease => (second = lease));
    await Promise.resolve();
    await Promise.resolve();
    expect(second).toBeUndefined();

    ctx.pool.release(first);
    await pending;

    expect(second.client).toBe(ctx.primary);
    expect(ctx.pool.size).toBe(1);
    ctx.pool.release(second);

    // A refusal is taken as the server's answer, not retried on every call.
    const third = await ctx.pool.acquire();
    ctx.pool.release(third);
    expect(attempts).toBe(1);
  });

  it('drops a connection that died under its holder', async () => {
    const ctx = createPool(4);

    const first = await ctx.pool.acquire();
    const second = await ctx.pool.acquire();
    second.invalidate();
    ctx.pool.release(second);

    expect(ctx.disconnected).toEqual([second.client]);
    expect(ctx.pool.size).toBe(1);

    ctx.pool.release(first);
  });

  it('retires a connection the transport reported as gone', async () => {
    const ctx = createPool(4);

    const first = await ctx.pool.acquire();
    const second = await ctx.pool.acquire();
    ctx.pool.release(second);

    // Reported while idle: dropped straight away.
    ctx.pool.discard(second.client);
    expect(ctx.pool.size).toBe(1);
    expect(ctx.disconnected).toEqual([second.client]);

    // Reported while in use: dropped once its holder is done with it.
    ctx.pool.discard(first.client);
    expect(ctx.pool.size).toBe(1);
    ctx.pool.release(first);
    expect(ctx.pool.size).toBe(0);
  });

  it('fails the caller instead of hanging when nothing is left', async () => {
    const ctx = createPool(1);

    const lease = await ctx.pool.acquire();
    lease.invalidate();
    ctx.pool.release(lease);

    await expect(ctx.pool.acquire()).rejects.toThrow(/closed/);
  });

  it('closes the connections it opened, but not the one it was lent', async () => {
    const ctx = createPool(3);

    const first = await ctx.pool.acquire();
    const second = await ctx.pool.acquire();
    ctx.pool.release(first);
    ctx.pool.release(second);

    ctx.pool.end();

    expect(ctx.disconnected).toEqual([second.client]);
  });
});
