import * as net from 'net';
import { offersTls, probeFtps, Support, withTls } from '../ftpsProbe';

describe('offersTls', () => {
  it('finds AUTH TLS in a feature listing, however it is spaced', () => {
    expect(offersTls('211-Features\r\n MDTM\r\n AUTH TLS\r\n211 End')).toBe(true);
    expect(offersTls('211-Features\r\nAUTH TLS\r\n211 End')).toBe(true);
    expect(offersTls('211-Features\r\n auth tls\r\n211 End')).toBe(true);
    expect(offersTls('211-Features\r\n AUTH-SSL\r\n211 End')).toBe(true);
  });

  it('is not fooled by something else beginning with AUTH', () => {
    expect(offersTls('211-Features\r\n MDTM\r\n SIZE\r\n211 End')).toBe(false);
    expect(offersTls('500 Unknown command')).toBe(false);
    // A file called AUTHTLS.txt in a listing is not a feature line.
    expect(offersTls('-rw-r--r-- 1 o g 12 Jan 01 00:00 AUTHTLS.txt')).toBe(false);
  });
});

/** A server that says exactly what the test wants it to say. */
function fakeServer(script: (line: string) => string | undefined, greeting = '220 ready\r\n') {
  const server = net.createServer(socket => {
    socket.write(greeting);
    socket.on('data', chunk => {
      const answer = script(chunk.toString('utf8').trim());
      if (answer) {
        socket.write(answer);
      }
    });
    socket.on('error', () => undefined);
  });

  return new Promise<{ port: number; close(): void }>(resolve =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as any).port,
        close: () => server.close(),
      })
    )
  );
}

describe('probeFtps', () => {
  it('reports a server that offers TLS', async () => {
    const server = await fakeServer(line =>
      line === 'FEAT' ? '211-Features\r\n AUTH TLS\r\n SIZE\r\n211 End\r\n' : undefined
    );

    expect(await probeFtps({ host: '127.0.0.1', port: server.port })).toBe(Support.Tls);
    server.close();
  });

  it('reports one that does not', async () => {
    const server = await fakeServer(line =>
      line === 'FEAT' ? '211-Features\r\n SIZE\r\n MDTM\r\n211 End\r\n' : undefined
    );

    expect(await probeFtps({ host: '127.0.0.1', port: server.port })).toBe(Support.None);
    server.close();
  });

  it('copes with a server that has never heard of FEAT', async () => {
    const server = await fakeServer(() => '500 Unknown command\r\n');

    expect(await probeFtps({ host: '127.0.0.1', port: server.port })).toBe(Support.None);
    server.close();
  });

  it('assumes nothing when the greeting refuses us', async () => {
    const server = await fakeServer(() => undefined, '421 Too many connections\r\n');

    expect(await probeFtps({ host: '127.0.0.1', port: server.port })).toBe(
      Support.Unknown
    );
    server.close();
  });

  it('gives up rather than hanging on a server that says nothing', async () => {
    const server = await fakeServer(() => undefined, '');

    const started = Date.now();
    const support = await probeFtps({
      host: '127.0.0.1',
      port: server.port,
      timeout: 300,
    });

    expect(support).toBe(Support.Unknown);
    expect(Date.now() - started).toBeLessThan(3000);
    server.close();
  });

  it('assumes nothing when nothing is listening', async () => {
    expect(
      await probeFtps({ host: '127.0.0.1', port: 1, timeout: 500 })
    ).toBe(Support.Unknown);
  });
});

describe('withTls', () => {
  const plain = { protocol: 'ftp', host: 'h', password: 'p' };

  it('adds TLS to a plain connection when the server offers it', () => {
    const upgraded = withTls(plain, Support.Tls);

    expect(upgraded.secure).toBe(true);
    expect(upgraded.secureByUpgrade).toBe(true);
    // Encrypted but unverified: better than the cleartext it replaces, worse
    // than a configured FTPS connection, and the difference is recorded.
    expect(upgraded.secureOptions.rejectUnauthorized).toBe(false);
  });

  it('leaves the connection alone when the server does not offer it', () => {
    expect(withTls(plain, Support.None)).toBe(plain);
    expect(withTls(plain, Support.Unknown)).toBe(plain);
  });

  it('never touches a connection the configuration already secured', () => {
    const configured = { ...plain, secure: true };
    expect(withTls(configured, Support.Tls)).toBe(configured);
  });

  it('never overrides secureOptions somebody wrote', () => {
    const withOwn = {
      ...plain,
      secureOptions: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    };

    const upgraded = withTls(withOwn, Support.Tls);

    expect(upgraded.secureOptions.rejectUnauthorized).toBe(true);
    expect(upgraded.secureOptions.minVersion).toBe('TLSv1.2');
  });

  it('does nothing to SFTP', () => {
    const sftp = { protocol: 'sftp', host: 'h' };
    expect(withTls(sftp, Support.Tls)).toBe(sftp);
  });
});
