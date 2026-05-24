/**
 * MCP client (M30). Outbound to external MCP servers. Every MCP tool call is
 * routed through the Capability Broker via a `mcp:<server>:<tool>` capability
 * namespace declared in `.archon/policy.yaml`. Default deny.
 *
 * Transport is line-delimited JSON over a duplex stream — `StreamLike` lets
 * us inject a fake in tests and a real child-process stdio in prod (the broker
 * spawns the server process; the client only sees its stdio).
 */

import {
  ERR_DENIED,
  ERR_INTERNAL,
  isResponse,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type McpCallToolResult,
  type McpToolDescription,
} from './protocol';

export interface StreamLike {
  send(line: string): void;
  /** AsyncIterable that yields raw lines (no newline). */
  lines(): AsyncIterable<string>;
  close(): void;
}

export interface McpClientOptions {
  /** Server identity (matches policy namespace `mcp:<server>:<tool>`). */
  server: string;
  /** Broker check — call returns 'allow'/'deny'. The client treats deny as fatal. */
  authorize(capability: string): Promise<'allow' | 'deny'>;
}

export class McpClient {
  private next = 1;
  private pending = new Map<number, (m: JsonRpcSuccess | { error: { code: number; message: string } }) => void>();
  private closed = false;

  constructor(private readonly io: StreamLike, private readonly opts: McpClientOptions) {
    void this.pump();
  }

  private async pump(): Promise<void> {
    for await (const line of this.io.lines()) {
      if (this.closed) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (!isResponse(msg)) continue;
      const id = msg.id;
      if (typeof id !== 'number') continue;
      const cb = this.pending.get(id);
      if (!cb) continue;
      this.pending.delete(id);
      if ('error' in msg) cb({ error: msg.error });
      else cb(msg);
    }
  }

  private async call<T>(method: string, params?: unknown): Promise<T> {
    const id = this.next++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (m) => {
        if ('error' in m) reject(new Error(`mcp ${method}: ${m.error.message} (${m.error.code})`));
        else resolve((m as JsonRpcSuccess<T>).result);
      });
      this.io.send(`${JSON.stringify(req)}\n`);
    });
  }

  /** Initialize the session. Must be the first call. */
  async initialize(): Promise<{ protocolVersion: string; serverInfo: { name: string; version: string } }> {
    return this.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  }

  /** List the tools the server advertises. */
  async listTools(): Promise<McpToolDescription[]> {
    const r = (await this.call('tools/list')) as { tools: McpToolDescription[] };
    return r.tools;
  }

  /** Call a tool — routed through broker authorization first. */
  async callTool(name: string, args: unknown): Promise<McpCallToolResult> {
    const cap = `mcp:${this.opts.server}:${name}`;
    const decision = await this.opts.authorize(cap);
    if (decision === 'deny') {
      // Surface as a structured error the caller can recognise.
      const e: Error & { code?: number } = new Error(`broker denied capability "${cap}"`);
      e.code = ERR_DENIED;
      throw e;
    }
    try {
      return await this.call<McpCallToolResult>('tools/call', { name, arguments: args });
    } catch (e) {
      const err: Error & { code?: number } = e instanceof Error ? e : new Error(String(e));
      if (err.code === undefined) err.code = ERR_INTERNAL;
      throw err;
    }
  }

  close(): void {
    this.closed = true;
    this.io.close();
    for (const cb of this.pending.values()) cb({ error: { code: ERR_INTERNAL, message: 'client closed' } });
    this.pending.clear();
  }
}
