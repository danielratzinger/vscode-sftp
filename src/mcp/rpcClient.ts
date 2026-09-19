import * as http from 'http';
import * as url from 'url';

/** One JSON-RPC message to another window, over the same loopback transport. */
export function postJson(
  endpoint: string,
  token: string,
  message: object,
  timeout: number = 15000
): Promise<any> {
  const target = url.parse(endpoint);
  const payload = Buffer.from(JSON.stringify(message), 'utf8');

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: target.hostname || '127.0.0.1',
        port: target.port,
        path: target.path || '/',
        method: 'POST',
        timeout,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          Authorization: `Bearer ${token}`,
        },
      },
      response => {
        let text = '';
        response.on('data', chunk => (text += chunk));
        response.on('end', () => {
          if (response.statusCode === 202 || text === '') {
            resolve(null);
            return;
          }

          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(new Error('That window sent something that is not JSON.'));
          }
        });
      }
    );

    request.on('timeout', () => {
      request.abort();
      reject(new Error('That window did not answer in time.'));
    });
    request.on('error', reject);
    request.end(payload);
  });
}
