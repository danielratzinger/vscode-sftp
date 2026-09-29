import * as Client from 'ftp';

/**
 * The rule is tested next door; this is the wiring, which is where a monkeypatch
 * goes wrong - wrapping the wrong method, dropping an argument, losing `this`.
 *
 * A stand-in goes on the prototype *before* the module is loaded, so that the
 * patch wraps it and the host it settles on can be read off. It delegates to a
 * variable rather than being replaced, because the patch captures whatever it
 * wraps exactly once - and reloading the module to re-wrap would hand `ftp` a
 * fresh prototype and leave this test watching the wrong object.
 */

let underneath: (this: any, ...args: any[]) => void = () => undefined;

(Client.prototype as any)._pasvConnect = function(this: any, ...args: any[]) {
  return underneath.apply(this, args);
};

// tslint:disable-next-line no-var-requires
require('../ftpClient');

const call = (advertised: string, control?: string, debug?: any) =>
  (Client.prototype as any)._pasvConnect.call(
    { _socket: control ? { remoteAddress: control } : undefined, _debug: debug },
    advertised,
    2121,
    () => undefined
  );

it('connects where the control connection is, not where PASV pointed', () => {
  const seen: any[] = [];
  underneath = function(ip: string, port: number, cb: any) {
    seen.push({ ip, port, cb: typeof cb });
  };

  call('10.8.169.245', '185.15.44.2');

  expect(seen).toEqual([{ ip: '185.15.44.2', port: 2121, cb: 'function' }]);
});

it('passes an address it has no reason to doubt straight through', () => {
  const seen: string[] = [];
  underneath = function(ip: string) {
    seen.push(ip);
  };

  call('185.15.44.9', '185.15.44.2');
  call('192.168.1.50', '192.168.1.1');
  call('10.0.0.1', undefined);

  expect(seen).toEqual(['185.15.44.9', '192.168.1.50', '10.0.0.1']);
});

it('says in the log that it went somewhere else, and why', () => {
  const said: string[] = [];
  underneath = () => undefined;

  call('10.8.169.245', '185.15.44.2', (line: string) => said.push(line));
  expect(said.join('\n')).toContain('10.8.169.245');
  expect(said.join('\n')).toContain('185.15.44.2');

  said.length = 0;
  call('185.15.44.9', '185.15.44.2', (line: string) => said.push(line));
  expect(said).toEqual([]);
});

it('keeps `this` intact for the call it wraps', () => {
  let socketSeen: any;
  underneath = function(this: any) {
    socketSeen = this._socket;
  };

  call('10.8.169.245', '185.15.44.2');
  expect(socketSeen).toEqual({ remoteAddress: '185.15.44.2' });
});
