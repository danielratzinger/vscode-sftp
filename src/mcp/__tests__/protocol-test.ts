import {
  createDispatcher,
  PROTOCOL_VERSION,
  ToolDefinition,
  toUtf8,
} from '../protocol';

function createTools(): ToolDefinition[] {
  return [
    {
      name: 'echo',
      description: 'Returns what it was given.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      run: async (args: any) => ({ text: String(args.text) }),
    },
    {
      name: 'structured',
      description: 'Returns data as well as prose.',
      inputSchema: { type: 'object' },
      run: async () => ({ text: 'two rows', structured: { rows: [1, 2] } }),
    },
    {
      name: 'explodes',
      description: 'Throws.',
      inputSchema: { type: 'object' },
      run: async () => {
        throw new Error('the server said no');
      },
    },
  ];
}

function createServer(onCall?: any) {
  return createDispatcher(
    { name: 'sftp', version: '1.0.0', instructions: 'Check freshness first.' },
    createTools,
    onCall
  );
}

const call = (name: string, args: any = {}, id: any = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('dispatcher', () => {
  it('answers initialize with the client\'s protocol version', async () => {
    const response: any = await createServer().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });

    expect(response.result.protocolVersion).toBe('2024-11-05');
    expect(response.result.serverInfo.name).toBe('sftp');
    expect(response.result.instructions).toContain('freshness');
    expect(response.result.capabilities.tools).toEqual({ listChanged: false });
  });

  it('falls back to its own protocol version', async () => {
    const response: any = await createServer().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    expect(response.result.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('answers ping', async () => {
    const response: any = await createServer().handle({
      jsonrpc: '2.0',
      id: 7,
      method: 'ping',
    });

    expect(response).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('lists tools without their handlers', async () => {
    const response: any = await createServer().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    expect(response.result.tools.map((t: any) => t.name)).toEqual([
      'echo',
      'structured',
      'explodes',
    ]);
    expect(response.result.tools[0].run).toBeUndefined();
  });

  it('calls a tool and wraps the text', async () => {
    const response: any = await createServer().handle(call('echo', { text: 'hi' }));

    expect(response.result.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(response.result.isError).toBe(false);
  });

  it('passes structured output alongside the text', async () => {
    const response: any = await createServer().handle(call('structured'));

    expect(response.result.structuredContent).toEqual({ rows: [1, 2] });
    expect(response.result.content[0].text).toBe('two rows');
  });

  it('never returns empty content', async () => {
    const response: any = await createServer().handle(call('echo', { text: '' }));

    expect(response.result.content[0].text).toBe('(no data)');
  });

  it('reports a throwing tool as a result, not a protocol error', async () => {
    const response: any = await createServer().handle(call('explodes'));

    // The model can read this and try something else; a JSON-RPC error would
    // just look like the server is broken.
    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('the server said no');
  });

  it('refuses an unknown tool and a missing name', async () => {
    const unknown: any = await createServer().handle(call('nope'));
    expect(unknown.error.message).toContain('Unknown tool');

    const nameless: any = await createServer().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {},
    });
    expect(nameless.error.message).toContain('Missing tool name');
  });

  it('refuses an unknown method', async () => {
    const response: any = await createServer().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/list',
    });

    expect(response.error.code).toBe(-32601);
  });

  it('says nothing to a notification', async () => {
    const response = await createServer().handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(response).toBeNull();
  });

  it('reports every call to the audit hook', async () => {
    const seen: string[] = [];
    const server = createServer((name: string, _args: any, result: any, error: any) =>
      seen.push(`${name}:${error ? 'threw' : result.isError ? 'error' : 'ok'}`)
    );

    await server.handle(call('echo', { text: 'x' }));
    await server.handle(call('explodes'));

    expect(seen).toEqual(['echo:ok', 'explodes:threw']);
  });
});

describe('batches', () => {
  it('answers each request in order', async () => {
    const responses: any = await createServer().handlePayload([
      call('echo', { text: 'one' }, 1),
      call('echo', { text: 'two' }, 2),
    ]);

    expect(responses.map((r: any) => r.result.content[0].text)).toEqual([
      'one',
      'two',
    ]);
  });

  it('drops notifications from the replies', async () => {
    const responses: any = await createServer().handlePayload([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      call('echo', { text: 'kept' }, 9),
    ]);

    expect(responses).toHaveLength(1);
    expect(responses[0].id).toBe(9);
  });

  it('answers nothing when a batch is all notifications', async () => {
    const responses = await createServer().handlePayload([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]);

    expect(responses).toBeNull();
  });

  it('refuses an empty batch and a non-object message', async () => {
    const empty: any = await createServer().handlePayload([]);
    expect(empty.error.code).toBe(-32600);

    const scalar: any = await createServer().handle('nonsense');
    expect(scalar.error.code).toBe(-32600);
  });
});

describe('toUtf8', () => {
  it('leaves ordinary text alone', () => {
    expect(toUtf8('plain ASCII')).toBe('plain ASCII');
    expect(toUtf8('accented pässwörd')).toBe('accented pässwörd');
    expect(toUtf8('emoji \u{1F511}')).toBe('emoji \u{1F511}');
  });

  it('substitutes a lone surrogate rather than failing the call', () => {
    const broken = 'before \uD800 after';
    const fixed = toUtf8(broken);

    expect(fixed).toContain('before');
    expect(fixed).toContain('after');
    // The whole point: the result must survive JSON encoding.
    expect(() => JSON.stringify({ text: fixed })).not.toThrow();
    expect(JSON.parse(JSON.stringify({ text: fixed })).text).toBe(fixed);
  });

  it('survives a trailing lone surrogate', () => {
    const fixed = toUtf8('tail \uDC00');
    expect(JSON.parse(JSON.stringify({ text: fixed })).text).toBe(fixed);
  });
});

describe('a call that never returns', () => {
  const hanging = [
    {
      name: 'sftp_search',
      title: 'Search',
      description: 'Never answers.',
      inputSchema: { type: 'object', properties: {} },
      run: () => new Promise<any>(() => undefined),
    },
  ];

  it('is stopped, and the model is told what to do instead', async () => {
    // Every operation is bounded, but a call is many operations; without this
    // a broad question can still sit there indefinitely.
    const dispatcher = createDispatcher(
      { name: 'test', version: '1', instructions: '' },
      () => hanging as any,
      { callTimeout: () => 20 }
    );

    const response: any = await dispatcher.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'sftp_search', arguments: {} },
    });

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('budget');
    expect(response.result.content[0].text).toContain('Ask for less');
  });

  it('waits as long as it takes when no ceiling is set', async () => {
    const dispatcher = createDispatcher(
      { name: 'test', version: '1', instructions: '' },
      () => hanging as any
    );

    let settled = false;
    dispatcher
      .handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'sftp_search', arguments: {} },
      })
      .then(() => (settled = true));

    await new Promise(done => setTimeout(done, 50));
    expect(settled).toBe(false);
  });
});

describe('what tools/list advertises', () => {
  it('passes an output schema through when a tool declares one', async () => {
    // A client that validates structuredContent needs to have been told the
    // shape; one that does not is unaffected either way.
    const tools = [
      {
        name: 'sftp_list',
        description: 'x',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        run: async () => ({ text: '' }),
      },
      {
        name: 'sftp_note',
        description: 'y',
        inputSchema: { type: 'object', properties: {} },
        run: async () => ({ text: '' }),
      },
    ];

    const dispatcher = createDispatcher(
      { name: 'test', version: '1', instructions: '' },
      () => tools as any
    );

    const response: any = await dispatcher.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    expect(response.result.tools[0].outputSchema).toEqual(tools[0].outputSchema);
    // Absent, not null: a tool that returns prose should not advertise a shape.
    expect('outputSchema' in response.result.tools[1]).toBe(false);
  });
});
