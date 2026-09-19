import {
  localiseCall,
  PeerRegistry,
  PEER_TIMEOUT,
  qualify,
  targetOf,
  unqualify,
} from '../peers';
import { createDispatcher, ToolDefinition } from '../protocol';

const connection = (id: string, name: string) => ({
  id, name, protocol: 'sftp', host: 'h', port: 22,
  remotePath: '/srv', workspace: '/work/' + name,
});

describe('qualifying ids', () => {
  it('round-trips a window and an id', () => {
    expect(unqualify(qualify('w2', '1'))).toEqual({ windowId: 'w2', id: '1' });
  });

  it('splits on the first separator, so an id may contain one', () => {
    expect(unqualify('w2:a:b')).toEqual({ windowId: 'w2', id: 'a:b' });
  });

  it('rejects something that is not qualified', () => {
    ['', '1', ':1', 'w2:'].forEach(value => expect(unqualify(value)).toBeUndefined());
  });
});

describe('PeerRegistry', () => {
  it('collects every window\'s connections under distinct ids', () => {
    const registry = new PeerRegistry();

    registry.register({
      windowId: 'w2', url: 'http://127.0.0.1:1', token: 't2',
      connections: [connection('1', 'alpha')],
    });
    registry.register({
      windowId: 'w3', url: 'http://127.0.0.1:2', token: 't3',
      connections: [connection('1', 'beta')],
    });

    // Both windows call theirs "1"; the client must be able to tell them apart.
    expect(registry.connections().map(c => c.id).sort()).toEqual(['w2:1', 'w3:1']);
    expect(registry.connections().map(c => c.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('replaces a registration rather than duplicating it', () => {
    const registry = new PeerRegistry();
    const base = { windowId: 'w2', url: 'u', token: 't' };

    registry.register({ ...base, connections: [connection('1', 'alpha')] });
    registry.register({ ...base, connections: [connection('1', 'alpha'), connection('2', 'gamma')] });

    expect(registry.connections()).toHaveLength(2);
  });

  it('forgets a window that has stopped checking in', () => {
    let now = 1000;
    const registry = new PeerRegistry(() => now);

    registry.register({
      windowId: 'w2', url: 'u', token: 't', connections: [connection('1', 'alpha')],
    });
    expect(registry.connections()).toHaveLength(1);

    now += PEER_TIMEOUT + 1;
    expect(registry.connections()).toHaveLength(0);
  });

  it('forgets a window that says goodbye', () => {
    const registry = new PeerRegistry();
    registry.register({ windowId: 'w2', url: 'u', token: 't', connections: [] });

    registry.forget('w2');
    expect(registry.peers()).toHaveLength(0);
  });

  it('finds which window owns an id', () => {
    const registry = new PeerRegistry();
    registry.register({
      windowId: 'w2', url: 'http://127.0.0.1:9', token: 't2',
      connections: [connection('1', 'alpha')],
    });

    expect(registry.ownerOf('w2:1')!.url).toBe('http://127.0.0.1:9');
    expect(registry.ownerOf('w9:1')).toBeUndefined();
    expect(registry.ownerOf('1')).toBeUndefined();
  });
});

describe('forwarding', () => {
  const message = {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'sftp_list', arguments: { server: 'w2:1', path: '/srv' } },
  };

  it('finds the server a call is aimed at', () => {
    expect(targetOf(message)).toBe('w2:1');
    expect(targetOf({ method: 'tools/list' })).toBeUndefined();
  });

  it('rewrites the id to the one the other window knows', () => {
    const localised = localiseCall(message, 'w2:1');

    expect(localised.params.arguments.server).toBe('1');
    // Everything else survives.
    expect(localised.params.arguments.path).toBe('/srv');
    expect(localised.id).toBe(1);
  });
});

describe('dispatcher hooks', () => {
  const tools = (): ToolDefinition[] => [
    {
      name: 'sftp_list', description: 'list', inputSchema: { type: 'object' },
      run: async () => ({ text: 'answered locally' }),
    },
  ];

  it('lets another window answer a call meant for it', async () => {
    const dispatcher = createDispatcher(
      { name: 'sftp', version: '1', instructions: '' },
      tools,
      {
        forward: async request =>
          (request.params as any).arguments.server.indexOf('w2:') === 0
            ? { jsonrpc: '2.0', id: request.id!, result: { content: [{ type: 'text', text: 'answered by w2' }] } }
            : undefined,
      }
    );

    const forwarded: any = await dispatcher.handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'sftp_list', arguments: { server: 'w2:1' } },
    });
    expect(forwarded.result.content[0].text).toBe('answered by w2');

    const local: any = await dispatcher.handle({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'sftp_list', arguments: { server: '1' } },
    });
    expect(local.result.content[0].text).toBe('answered locally');
  });

  it('answers the private peer methods without exposing them as tools', async () => {
    const seen: string[] = [];
    const dispatcher = createDispatcher(
      { name: 'sftp', version: '1', instructions: '' },
      tools,
      {
        peer: async (method: string) => {
          seen.push(method);
          return { ok: true };
        },
      }
    );

    const registered: any = await dispatcher.handle({
      jsonrpc: '2.0', id: 1, method: 'peer/register', params: { windowId: 'w2' },
    });
    expect(registered.result).toEqual({ ok: true });
    expect(seen).toEqual(['peer/register']);

    const listed: any = await dispatcher.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(listed.result.tools.map((t: any) => t.name)).toEqual(['sftp_list']);
  });

  it('still refuses an unknown method that is not a peer one', async () => {
    const dispatcher = createDispatcher(
      { name: 'sftp', version: '1', instructions: '' },
      tools,
      { peer: async () => ({}) }
    );

    const response: any = await dispatcher.handle({
      jsonrpc: '2.0', id: 1, method: 'resources/list',
    });
    expect(response.error.code).toBe(-32601);
  });
});
