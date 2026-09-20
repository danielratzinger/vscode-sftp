import { createDispatcher, ToolDefinition } from '../protocol';
import { startServer, StartedServer } from '../server';
import { postJson } from '../rpcClient';
import { localiseCall, PeerRegistry, targetOf, unqualify } from '../peers';

/**
 * Two windows, for real: a leader and a follower, each with its own server,
 * talking over loopback exactly as they would in the editor.
 */
describe('one leader answering for two windows', () => {
  let leader: StartedServer;
  let follower: StartedServer;
  const leaderToken = 'tok_leader';
  const followerToken = 'tok_follower';
  const peers = new PeerRegistry();

  const toolsFor = (label: string): (() => ToolDefinition[]) => () => [
    {
      name: 'list',
      description: 'list',
      inputSchema: { type: 'object' },
      run: async (args: any) => ({
        text: `${label} answered for server ${args.server}`,
      }),
    },
  ];

  beforeAll(async () => {
    follower = await startServer({
      token: followerToken,
      dispatcher: createDispatcher(
        { name: 'sftp', version: '1', instructions: '' },
        toolsFor('follower')
      ),
    });

    leader = await startServer({
      token: leaderToken,
      dispatcher: createDispatcher(
        { name: 'sftp', version: '1', instructions: '' },
        toolsFor('leader'),
        {
          peer: async (method, params) => {
            if (method === 'peer/register') {
              peers.register(params);
              return { ok: true };
            }
            peers.forget(params.windowId);
            return { ok: true };
          },
          forward: async message => {
            const target = targetOf(message);
            if (!target || !unqualify(target)) return undefined;
            const owner = peers.ownerOf(target);
            if (!owner) return undefined;

            try {
              return await postJson(owner.url, owner.token, localiseCall(message, target));
            } catch (error) {
              // Same as forwardToOwner: a window that has gone is reported the
              // way one that never existed is.
              peers.forget(owner.windowId);
              return {
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  content: [{ type: 'text', text: 'Unknown server.' }],
                  isError: true,
                },
              };
            }
          },
        }
      ),
    });
  });

  afterAll(async () => {
    await leader.close();
    await follower.close();
  });

  const ask = (message: object) =>
    postJson(`http://127.0.0.1:${leader.port}/`, leaderToken, message);

  const call = (server: string, id = 1) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'list', arguments: { server } },
  });

  it('registers the follower with the leader', async () => {
    const response = await ask({
      jsonrpc: '2.0',
      id: 1,
      method: 'peer/register',
      params: {
        windowId: 'w2',
        url: `http://127.0.0.1:${follower.port}/`,
        token: followerToken,
        workspace: '/work/other',
        connections: [
          { id: '1', name: 'Other project', protocol: 'sftp', host: 'h', port: 22, remotePath: '/srv', workspace: '/work/other' },
        ],
      },
    });

    expect(response.result).toEqual({ ok: true });
    expect(peers.connections().map(c => c.id)).toEqual(['w2:1']);
  });

  it('answers its own connections itself', async () => {
    const response = await ask(call('1'));

    expect(response.result.content[0].text).toBe('leader answered for server 1');
  });

  it('hands a call for the other window to that window', async () => {
    const response = await ask(call('w2:1', 2));

    // Answered by the follower, with the id it knows itself by.
    expect(response.result.content[0].text).toBe('follower answered for server 1');
    expect(response.id).toBe(2);
  });

  it('reports a window that has gone as an unknown server', async () => {
    peers.register({
      windowId: 'w3',
      url: 'http://127.0.0.1:1/',
      token: 'gone',
      connections: [],
    });

    const response = await ask(call('w3:1', 3));
    expect(response.result.isError).toBe(true);
  });

  it('forgets a window that says goodbye', async () => {
    await ask({
      jsonrpc: '2.0',
      id: 9,
      method: 'peer/unregister',
      params: { windowId: 'w2' },
    });

    expect(peers.connections()).toHaveLength(0);
  });
});
