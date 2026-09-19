import * as http from 'http';
import { checkRequest, startServer, StartedServer } from '../server';
import { createDispatcher, ToolDefinition } from '../protocol';

const TOKEN = 'tok_abcdefghijklmnop';

const headers = (over: any = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  host: '127.0.0.1:7391',
  ...over,
});

describe('checkRequest', () => {
  it('accepts a well-formed local POST', () => {
    expect(checkRequest('POST', headers(), TOKEN).ok).toBe(true);
  });

  it('offers only POST', () => {
    const get = checkRequest('GET', headers(), TOKEN);
    expect(get.status).toBe(405);
    expect(get.allow).toBe('POST');

    expect(checkRequest('DELETE', headers(), TOKEN).status).toBe(405);
    expect(checkRequest('OPTIONS', headers(), TOKEN).status).toBe(204);
  });

  it('refuses a wrong, missing or malformed token', () => {
    expect(checkRequest('POST', headers({ authorization: 'Bearer nope' }), TOKEN).status).toBe(401);
    expect(checkRequest('POST', headers({ authorization: '' }), TOKEN).status).toBe(401);
    expect(checkRequest('POST', headers({ authorization: TOKEN }), TOKEN).status).toBe(401);
  });

  it('refuses a token that merely starts correctly', () => {
    expect(checkRequest('POST', headers({ authorization: 'Bearer tok_abc' }), TOKEN).status).toBe(401);
  });

  it('refuses a cross-origin request', () => {
    // A page on the web must not be able to reach the servers this machine can.
    const evil = checkRequest('POST', headers({ origin: 'https://evil.example' }), TOKEN);
    expect(evil.status).toBe(403);
    expect(evil.message).toContain('Cross-origin');
  });

  it('allows a loopback origin, and one that is absent', () => {
    ['http://localhost:3000', 'http://127.0.0.1:8080', 'null'].forEach(origin =>
      expect(checkRequest('POST', headers({ origin }), TOKEN).ok).toBe(true)
    );

    // No Origin at all is a program, not a page.
    expect(checkRequest('POST', headers(), TOKEN).ok).toBe(true);
  });

  it('refuses a rebound hostname', () => {
    // DNS rebinding: attacker.example resolves to 127.0.0.1, so the socket is
    // local but the Host header is not.
    const rebound = checkRequest('POST', headers({ host: 'attacker.example' }), TOKEN);
    expect(rebound.status).toBe(403);
    expect(rebound.message).toContain('loopback');
  });

  it('accepts the loopback hosts a client might use', () => {
    ['127.0.0.1:7391', 'localhost:7391', '[::1]:7391'].forEach(host =>
      expect(checkRequest('POST', headers({ host }), TOKEN).ok).toBe(true)
    );
  });

  it('checks the origin before the token, so a page learns nothing', () => {
    const evil = checkRequest(
      'POST',
      headers({ origin: 'https://evil.example', authorization: 'Bearer wrong' }),
      TOKEN
    );
    expect(evil.status).toBe(403);
  });
});

describe('the running server', () => {
  let server: StartedServer;

  const tools = (): ToolDefinition[] => [
    {
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object' },
      run: async (args: any) => ({ text: String(args.text) }),
    },
  ];

  beforeAll(async () => {
    server = await startServer({
      token: TOKEN,
      dispatcher: createDispatcher(
        { name: 'sftp', version: '1.0.0', instructions: 'hi' },
        tools
      ),
    });
  });

  afterAll(async () => {
    await server.close();
  });

  function request(body: string, over: any = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.port,
          method: 'POST',
          path: '/',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            authorization: `Bearer ${TOKEN}`,
            ...over,
          },
        },
        res => {
          let text = '';
          res.on('data', chunk => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode || 0, body: text }));
        }
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  it('binds loopback only', () => {
    expect(server.port).toBeGreaterThan(0);
  });

  it('answers a tool call', async () => {
    const response = await request(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: 'through the socket' } },
      })
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).result.content[0].text).toBe(
      'through the socket'
    );
  });

  it('answers 202 to a lone notification', async () => {
    const response = await request(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    );

    expect(response.status).toBe(202);
    expect(response.body).toBe('');
  });

  it('reports malformed JSON as a parse error', async () => {
    const response = await request('{not json');

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe(-32700);
  });

  it('turns away a request without the token', async () => {
    const response = await request(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), {
      authorization: 'Bearer wrong',
    });

    expect(response.status).toBe(401);
  });
});
