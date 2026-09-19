/**
 * The MCP wire protocol: JSON-RPC 2.0 over a single request/response channel.
 *
 * The server never initiates a message, so there is no streaming to manage and
 * no session state to lose. That reduces the whole protocol to four methods
 * plus the good manners around them, which is why this is hand-written rather
 * than pulled from an SDK.
 */

import { withBudget } from './budget';

export const PROTOCOL_VERSION = '2025-06-18';

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string };
}

export interface ToolResult {
  /** What the model reads. */
  text: string;
  /** Machine-readable form, for tools that return data rather than prose. */
  structured?: object;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: object;
  /**
   * What `structuredContent` looks like. A client that validates it needs to
   * have been told the shape; one that does not is unaffected. Declared only
   * by the tools that return structured data at all.
   */
  outputSchema?: object;
  annotations?: object;
  run(args: any): Promise<ToolResult>;
}

export interface ServerInfo {
  name: string;
  version: string;
  /** Sets the workflow before any tool is chosen. */
  instructions: string;
}

export const enum RpcError {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
}

function ok(id: JsonRpcRequest['id'], result: any): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function fail(
  id: JsonRpcRequest['id'],
  code: number,
  message: string
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: { code, message },
  };
}

/**
 * A file on a server is not obliged to be UTF-8, and a single stray byte makes
 * the whole JSON envelope fail to encode. What the user sees then is a
 * transport error naming no tool and no path, which is far worse than one
 * replacement character in one line.
 */
export function toUtf8(text: string): string {
  // A lone surrogate is the shape an invalid byte sequence takes once it has
  // been decoded into a JS string; JSON.stringify refuses to encode it.
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g, match =>
    match.length === 2 ? match[0] + '�' : '�'
  );
}

export interface Dispatcher {
  handle(message: any): Promise<JsonRpcResponse | null>;
  handlePayload(payload: any): Promise<JsonRpcResponse | JsonRpcResponse[] | null>;
}

export interface DispatcherHooks {
  onCall?(name: string, args: any, result: ToolResult | null, error?: Error): void;
  /**
   * The ceiling on one call, in milliseconds. The tools that loop stop
   * themselves before this; it is here so that one which does not cannot run
   * past it anyway.
   */
  callTimeout?(): number;
  /**
   * Handles the private `peer/*` methods windows use to find each other. Not
   * tools, so a client never sees them in `tools/list`.
   */
  peer?(method: string, params: any): Promise<any>;
  /**
   * Given a `tools/call`, either answers it from another window or returns
   * undefined to let this one handle it.
   */
  forward?(message: JsonRpcRequest): Promise<JsonRpcResponse | undefined>;
}

export function createDispatcher(
  serverInfo: ServerInfo,
  listTools: () => ToolDefinition[],
  hooks: DispatcherHooks | DispatcherHooks['onCall'] = {}
): Dispatcher {
  const { onCall, peer, forward, callTimeout } =
    typeof hooks === 'function'
      ? {
          onCall: hooks,
          peer: undefined,
          forward: undefined,
          callTimeout: undefined,
        }
      : hooks;

  async function handle(message: any): Promise<JsonRpcResponse | null> {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return fail(null, RpcError.InvalidRequest, 'Invalid Request');
    }

    const request = message as JsonRpcRequest;

    // A notification carries no id and expects no reply.
    if (!('id' in message)) {
      return null;
    }

    const id = request.id === undefined ? null : request.id;
    const method = typeof request.method === 'string' ? request.method : '';
    const params =
      request.params && typeof request.params === 'object' ? request.params : {};

    switch (method) {
      case 'initialize': {
        const requested =
          typeof params.protocolVersion === 'string' && params.protocolVersion
            ? params.protocolVersion
            : PROTOCOL_VERSION;

        return ok(id, {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverInfo.name, version: serverInfo.version },
          instructions: serverInfo.instructions,
        });
      }

      case 'ping':
        return ok(id, {});

      case 'tools/list':
        return ok(id, {
          tools: listTools().map(tool => {
            const listed: any = {
              name: tool.name,
              title: tool.title,
              description: tool.description,
              inputSchema: tool.inputSchema,
              annotations: tool.annotations,
            };

            if (tool.outputSchema) {
              listed.outputSchema = tool.outputSchema;
            }

            return listed;
          }),
        });

      case 'tools/call': {
        if (forward) {
          const answered = await forward(request);
          if (answered) {
            return answered;
          }
        }

        const name = typeof params.name === 'string' ? params.name : '';
        const args =
          params.arguments && typeof params.arguments === 'object'
            ? params.arguments
            : {};

        if (!name) {
          return fail(id, RpcError.InvalidParams, 'Missing tool name.');
        }

        const tool = listTools().find(candidate => candidate.name === name);
        if (!tool) {
          return fail(id, RpcError.InvalidParams, `Unknown tool: ${name}`);
        }

        let result: ToolResult;
        try {
          result = await withBudget(
            Promise.resolve(tool.run(args)),
            callTimeout ? callTimeout() : 0,
            name
          );
        } catch (error) {
          // A failing tool is a result, not a protocol error: the model can
          // read the reason and try something else.
          result = { text: `Tool error: ${error.message}`, isError: true };
          if (onCall) {
            onCall(name, args, null, error);
          }
          return ok(id, toCallResult(result));
        }

        if (onCall) {
          onCall(name, args, result);
        }
        return ok(id, toCallResult(result));
      }

      default:
        if (peer && method.indexOf('peer/') === 0) {
          try {
            return ok(id, await peer(method, params));
          } catch (error) {
            return fail(id, RpcError.InvalidParams, error.message);
          }
        }

        return fail(id, RpcError.MethodNotFound, `Method not found: ${method}`);
    }
  }

  async function handlePayload(payload: any) {
    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        return fail(null, RpcError.InvalidRequest, 'Invalid Request');
      }

      const responses: JsonRpcResponse[] = [];
      for (const message of payload) {
        const response = await handle(message);
        if (response !== null) {
          responses.push(response);
        }
      }

      // Every message was a notification; nothing to answer with.
      return responses.length > 0 ? responses : null;
    }

    return handle(payload);
  }

  return { handle, handlePayload };
}

function toCallResult(result: ToolResult) {
  const text = toUtf8(result.text === '' ? '(no data)' : result.text);
  const callResult: any = {
    content: [{ type: 'text', text }],
    isError: Boolean(result.isError),
  };

  if (result.structured) {
    callResult.structuredContent = result.structured;
  }

  return callResult;
}
