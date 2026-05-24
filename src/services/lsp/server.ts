/**
 * LSP bridge (M39). Minimal language-server-protocol surface so JetBrains /
 * VS Code / Neovim can talk to Archon without a custom plugin. Methods routed:
 *   - initialize
 *   - shutdown / exit
 *   - workspace/executeCommand → broker-mediated `archon.<cmd>`
 *   - archon/blastRadius / archon/explain / archon/violations (custom methods)
 *   - textDocument/publishDiagnostics (server → client push)
 *
 * Transport is JSON-RPC 2.0 over the standard LSP framing (`Content-Length`
 * header). We share the JSON-RPC types with MCP since the wire is the same;
 * the framing differs (LSP wraps with headers; MCP uses line-delimited JSON).
 */

import {
  ERR_METHOD_NOT_FOUND,
  ERR_INVALID_PARAMS,
  type JsonRpcError,
  type JsonRpcMessage,
  type JsonRpcSuccess,
  isRequest,
} from '../mcp/protocol';
import type { LspDiagnostic } from './protocol';

export interface LspTransport {
  /** Send a fully-framed message. */
  send(framed: string): void;
  /** AsyncIterable of decoded JSON-RPC messages. */
  messages(): AsyncIterable<JsonRpcMessage>;
  close(): void;
}

export interface ArchonLspHandlers {
  blastRadius(args: { path: string }): Promise<{ files: string[]; symbols: string[] }>;
  explain(args: { symbol: string }): Promise<{ summary: string; neighbours: string[] }>;
  violations(args: { path?: string }): Promise<LspDiagnostic[]>;
  executeCommand(name: string, args: unknown[]): Promise<unknown>;
}

export class ArchonLspServer {
  private running = false;

  constructor(private readonly io: LspTransport, private readonly handlers: ArchonLspHandlers) {}

  async serve(): Promise<void> {
    this.running = true;
    for await (const msg of this.io.messages()) {
      if (!this.running) break;
      if (!isRequest(msg)) continue;
      try {
        const result = await this.dispatch(msg.method, msg.params);
        const reply: JsonRpcSuccess = { jsonrpc: '2.0', id: msg.id, result };
        this.io.send(frame(reply));
      } catch (e) {
        const err: JsonRpcError = {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: ERR_INVALID_PARAMS, message: e instanceof Error ? e.message : String(e) },
        };
        this.io.send(frame(err));
      }
    }
  }

  stop(): void {
    this.running = false;
    this.io.close();
  }

  /** Server-push diagnostics. */
  publishDiagnostics(uri: string, diagnostics: LspDiagnostic[]): void {
    this.io.send(
      frame({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri, diagnostics },
      }),
    );
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          capabilities: {
            codeActionProvider: true,
            executeCommandProvider: { commands: ['archon.blastRadius', 'archon.explain'] },
          },
          serverInfo: { name: 'archon-lsp', version: '0.1.0' },
        };
      case 'shutdown':
        return null;
      case 'exit':
        this.stop();
        return null;
      case 'archon/blastRadius':
        return this.handlers.blastRadius(params as { path: string });
      case 'archon/explain':
        return this.handlers.explain(params as { symbol: string });
      case 'archon/violations':
        return this.handlers.violations((params as { path?: string }) ?? {});
      case 'workspace/executeCommand': {
        const p = params as { command?: string; arguments?: unknown[] };
        if (!p?.command) throw new Error('missing command');
        return this.handlers.executeCommand(p.command, p.arguments ?? []);
      }
      default: {
        const e: Error & { code?: number } = new Error(`method "${method}" not found`);
        e.code = ERR_METHOD_NOT_FOUND;
        throw e;
      }
    }
  }
}

/** Apply LSP `Content-Length` framing to a JSON-RPC message. */
export function frame(message: JsonRpcMessage): string {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

/**
 * Parse a buffer-accumulating LSP stream into discrete messages. Callers feed
 * chunks via `push(chunk)` and consume via the returned iterable.
 */
export function lspDecoder(): { push(chunk: string): void; messages: AsyncIterable<JsonRpcMessage>; close(): void } {
  let buf = '';
  let closed = false;
  const queue: JsonRpcMessage[] = [];
  const resolvers: Array<(m: JsonRpcMessage | null) => void> = [];

  const tryParse = (): void => {
    while (true) {
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = buf.slice(0, headerEnd);
      const lenMatch = /Content-Length: (\d+)/i.exec(header);
      if (!lenMatch) {
        buf = buf.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(lenMatch[1] as string, 10);
      const bodyStart = headerEnd + 4;
      if (buf.length < bodyStart + len) return;
      const body = buf.slice(bodyStart, bodyStart + len);
      buf = buf.slice(bodyStart + len);
      try {
        const m = JSON.parse(body) as JsonRpcMessage;
        const r = resolvers.shift();
        if (r) r(m);
        else queue.push(m);
      } catch {
        // Skip malformed message; LSP server will surface a parse error on the next request.
      }
    }
  };

  return {
    push(chunk: string) {
      buf += chunk;
      tryParse();
    },
    close() {
      closed = true;
      while (resolvers.length) (resolvers.shift() as (m: null) => void)(null);
    },
    messages: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<JsonRpcMessage>> {
            if (queue.length > 0) return { value: queue.shift() as JsonRpcMessage, done: false };
            if (closed) return { value: undefined, done: true };
            const next = await new Promise<JsonRpcMessage | null>((res) => resolvers.push(res));
            if (next === null) return { value: undefined, done: true };
            return { value: next, done: false };
          },
          async return(): Promise<IteratorResult<JsonRpcMessage>> {
            return { value: undefined, done: true };
          },
        };
      },
    },
  };
}
