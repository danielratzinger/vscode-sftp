import * as http from 'http';
import { Dispatcher } from './protocol';

export const LOOPBACK = '127.0.0.1';

export interface RequestCheck {
  ok: boolean;
  status?: number;
  message?: string;
  /** Sent with a 405, per HTTP. */
  allow?: string;
}

const OK: RequestCheck = { ok: true };

function headerOf(headers: any, name: string): string {
  const value = headers ? headers[name] : undefined;
  if (Array.isArray(value)) {
    return String(value[0] || '');
  }
  return value === undefined || value === null ? '' : String(value);
}

/**
 * A browser can reach a loopback port, so the two checks below are what stand
 * between a web page and somebody's production servers.
 *
 * `Origin` catches a page making a cross-origin request; `Host` catches DNS
 * rebinding, where a name the attacker controls resolves to 127.0.0.1 and the
 * request therefore arrives with their hostname in it. A request with neither
 * header is a program, not a page, and is judged on its token alone.
 */
export function checkRequest(
  method: string,
  headers: any,
  token: string
): RequestCheck {
  if (method === 'OPTIONS') {
    return { ok: false, status: 204 };
  }

  if (method !== 'POST') {
    return {
      ok: false,
      status: 405,
      allow: 'POST',
      message: 'Only HTTP POST is supported at this endpoint.',
    };
  }

  const origin = headerOf(headers, 'origin');
  if (origin !== '' && origin !== 'null' && !isLoopbackOrigin(origin)) {
    return { ok: false, status: 403, message: 'Cross-origin requests are refused.' };
  }

  const host = headerOf(headers, 'host');
  if (host !== '' && !isLoopbackHost(host)) {
    return {
      ok: false,
      status: 403,
      message: 'This server answers only on the loopback address.',
    };
  }

  const authorization = headerOf(headers, 'authorization');
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(authorization);
  if (!match || !safeEqual(match[1], token)) {
    return { ok: false, status: 401, message: 'Unauthorized.' };
  }

  return OK;
}

function isLoopbackOrigin(origin: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin);
}

function isLoopbackHost(host: string): boolean {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
}

/** Constant-time enough for a token comparison on a local socket. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let differences = 0;
  for (let i = 0; i < a.length; i += 1) {
    // Compared in full rather than short-circuiting, so the time taken does
    // not narrow down how much of a guess was right.
    differences += a.charCodeAt(i) === b.charCodeAt(i) ? 0 : 1;
  }
  return differences === 0;
}

export interface StartedServer {
  port: number;
  close(): Promise<void>;
}

export interface ServerOption {
  token: string;
  /** 0 asks the OS for a free port. */
  port?: number;
  dispatcher: Dispatcher;
  onError?(error: Error): void;
}

const MAX_BODY = 4 * 1024 * 1024;

export function startServer(option: ServerOption): Promise<StartedServer> {
  const server = http.createServer((req, res) => {
    const check = checkRequest(req.method || 'GET', req.headers, option.token);

    if (!check.ok) {
      const status = check.status || 400;
      const headers: any = { 'Content-Type': 'application/json' };
      if (check.allow) {
        headers.Allow = check.allow;
      }

      res.writeHead(status, headers);
      res.end(
        check.message
          ? JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32000, message: check.message },
            })
          : ''
      );
      return;
    }

    readBody(req, MAX_BODY).then(
      async raw => {
        let payload: any;
        try {
          payload = JSON.parse(raw);
        } catch (error) {
          respond(res, 400, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error.' },
          });
          return;
        }

        try {
          const answer = await option.dispatcher.handlePayload(payload);
          if (answer === null) {
            // Everything was a notification; there is nothing to say.
            res.writeHead(202);
            res.end();
            return;
          }

          respond(res, 200, answer);
        } catch (error) {
          if (option.onError) {
            option.onError(error);
          }
          respond(res, 500, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: 'Internal error.' },
          });
        }
      },
      error => {
        respond(res, 413, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: error.message },
        });
      }
    );
  });

  return new Promise<StartedServer>((resolve, reject) => {
    server.once('error', reject);
    // Loopback only. Binding anywhere else would expose the servers this
    // machine can reach to the network it is on.
    server.listen(option.port || 0, LOOPBACK, () => {
      server.removeListener('error', reject);
      if (option.onError) {
        server.on('error', option.onError);
      }

      const address = server.address() as any;
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>(done => {
            server.close(() => done());
          }),
      });
    });
  });
}

function respond(res: http.ServerResponse, status: number, body: any) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
