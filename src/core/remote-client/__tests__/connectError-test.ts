import * as net from 'net';
import { Client } from 'ssh2';
import { describeConnectError } from '../connectError';

/** A port that was open a moment ago and is not now. */
function closedPort(): Promise<number> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * `localhost` resolves to both ::1 and 127.0.0.1, so Node tries both and,
 * with neither listening, reports the two failures as one AggregateError with
 * an empty message - the same shape a host refusing on IPv4 and unreachable
 * on IPv6 produces.
 */
function failedConnection(port: number): Promise<any> {
  return new Promise(resolve => {
    net
      .connect({ host: 'localhost', port, autoSelectFamily: true } as any)
      .on('error', resolve);
  });
}

describe('describeConnectError', () => {
  it('spells out every address that was tried', async () => {
    const port = await closedPort();
    const error = await failedConnection(port);

    // The premise: what Node hands over says nothing by itself.
    expect(error.message).toBe('');

    const text = describeConnectError(error);
    expect(text).toContain(`127.0.0.1:${port}`);
    expect(text).toContain('ECONNREFUSED');
  });

  it('says it for what ssh2 passes on, too', async () => {
    const port = await closedPort();
    const error = await new Promise<any>(resolve => {
      const client = new Client();
      client.on('error', resolve).connect({ host: 'localhost', port, username: 'nobody', readyTimeout: 5000 });
    });

    expect(describeConnectError(error)).toContain(`127.0.0.1:${port}`);
  });

  it('leaves a message that says something alone', () => {
    expect(describeConnectError(new Error('All configured authentication methods failed'))).toBe(
      'All configured authentication methods failed'
    );
  });

  it('never comes back empty', () => {
    expect(describeConnectError(new Error(''))).not.toBe('');
    expect(describeConnectError(undefined)).not.toBe('');
  });
});

describe('the local end of the attempt', () => {
  // As Node wrote it in a real failure: the local port says nothing about why.
  it('is left out', () => {
    const error: any = new Error('');
    error.errors = [
      new Error('connect ETIMEDOUT 80.74.153.100:2121'),
      new Error('connect EHOSTUNREACH 2a00:1128:0:153::100:2121 - Local (:::52661)'),
    ];

    expect(describeConnectError(error)).toBe(
      'connect ETIMEDOUT 80.74.153.100:2121; connect EHOSTUNREACH 2a00:1128:0:153::100:2121'
    );
  });
});
