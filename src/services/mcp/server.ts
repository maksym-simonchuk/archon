/**
 * MCP server (M31). Inbound from external clients (Claude Code, Cursor, Codex).
 * Exposes a strict read-only subset of Archon's tools by default; mutating
 * tools require an explicit `trusted` opt-in per ADR-0015.
 */

import {
  ERR_INVALID_PARAMS,
  ERR_METHOD_NOT_FOUND,
  ERR_PARSE,
  isRequest,
  type JsonRpcError,
  type JsonRpcMessage,
  type JsonRpcSuccess,
  type McpCallToolResult,
  type McpToolDescription,
} from './protocol';
import type { StreamLike } from './client';

export interface ServerTool {
  desc: McpToolDescription;
  /** Whether this tool mutates state. Mutating tools require `mutatingEnabled`. */
  mutating: boolean;
  /** Synchronous or async; throw to fail the call. */
  invoke(args: unknown): Promise<McpCallToolResult>;
}

export interface McpServerOptions {
  name: string;
  version: string;
  tools: ServerTool[];
  /** If false (default), mutating tools are hidden from `tools/list` and rejected on `tools/call`. */
  mutatingEnabled?: boolean;
}

export class McpServer {
  private running = false;

  constructor(private readonly io: StreamLike, private readonly opts: McpServerOptions) {}

  async serve(): Promise<void> {
    this.running = true;
    for await (const line of this.io.lines()) {
      if (!this.running) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        this.send({ jsonrpc: '2.0', id: null, error: { code: ERR_PARSE, message: 'parse error' } });
        continue;
      }
      if (!isRequest(msg)) continue;
      try {
        const result = await this.dispatch(msg.method, msg.params);
        const reply: JsonRpcSuccess = { jsonrpc: '2.0', id: msg.id, result };
        this.send(reply);
      } catch (e) {
        const err: JsonRpcError = {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: ERR_INVALID_PARAMS, message: e instanceof Error ? e.message : String(e) },
        };
        this.send(err);
      }
    }
  }

  private send(m: JsonRpcMessage): void {
    this.io.send(`${JSON.stringify(m)}\n`);
  }

  stop(): void {
    this.running = false;
    this.io.close();
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: '2024-11-05',
          serverInfo: { name: this.opts.name, version: this.opts.version },
          capabilities: { tools: { listChanged: false } },
        };
      case 'tools/list':
        return { tools: this.visibleTools().map((t) => t.desc) };
      case 'tools/call': {
        const p = params as { name?: string; arguments?: unknown };
        if (!p || typeof p.name !== 'string') throw new Error('missing tool name');
        const tool = this.visibleTools().find((t) => t.desc.name === p.name);
        if (!tool) {
          const e: Error & { code?: number } = new Error(`unknown tool "${p.name}"`);
          e.code = ERR_METHOD_NOT_FOUND;
          throw e;
        }
        return tool.invoke(p.arguments);
      }
      default: {
        const e: Error & { code?: number } = new Error(`method "${method}" not found`);
        e.code = ERR_METHOD_NOT_FOUND;
        throw e;
      }
    }
  }

  private visibleTools(): ServerTool[] {
    return this.opts.mutatingEnabled ? this.opts.tools : this.opts.tools.filter((t) => !t.mutating);
  }
}

/** In-memory duplex pair used in tests + for in-process embedding. */
export function memoryPipe(): { a: StreamLike; b: StreamLike } {
  const aQ: string[] = [];
  const bQ: string[] = [];
  const aResolvers: Array<(s: string | null) => void> = [];
  const bResolvers: Array<(s: string | null) => void> = [];
  let closed = false;

  const makeIter = (q: string[], resolvers: Array<(s: string | null) => void>): AsyncIterable<string> => ({
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          if (q.length > 0) return { value: q.shift() as string, done: false };
          if (closed) return { value: undefined, done: true };
          const next = await new Promise<string | null>((res) => resolvers.push(res));
          if (next === null) return { value: undefined, done: true };
          return { value: next, done: false };
        },
        async return(): Promise<IteratorResult<string>> {
          return { value: undefined, done: true };
        },
      };
    },
  });

  return {
    a: {
      send(line: string) {
        for (const piece of line.split('\n')) {
          if (piece === '') continue;
          const r = bResolvers.shift();
          if (r) r(piece);
          else bQ.push(piece);
        }
      },
      lines() {
        return makeIter(aQ, aResolvers);
      },
      close() {
        closed = true;
        while (aResolvers.length) (aResolvers.shift() as (s: null) => void)(null);
        while (bResolvers.length) (bResolvers.shift() as (s: null) => void)(null);
      },
    },
    b: {
      send(line: string) {
        for (const piece of line.split('\n')) {
          if (piece === '') continue;
          const r = aResolvers.shift();
          if (r) r(piece);
          else aQ.push(piece);
        }
      },
      lines() {
        return makeIter(bQ, bResolvers);
      },
      close() {
        closed = true;
        while (aResolvers.length) (aResolvers.shift() as (s: null) => void)(null);
        while (bResolvers.length) (bResolvers.shift() as (s: null) => void)(null);
      },
    },
  };
}
