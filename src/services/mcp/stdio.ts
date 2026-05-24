/**
 * Stdio transport for the MCP server. Wraps `process.stdin` / `process.stdout`
 * as a `StreamLike` so external clients (Claude Code, Cursor, Codex) can talk
 * to Archon over a child-process stdio JSON-RPC pipe — the canonical MCP
 * transport. Line-delimited JSON, no framing headers (MCP's line-by-line
 * convention; LSP would use Content-Length, see `services/lsp/server.ts`).
 *
 * The adapter is intentionally narrow: one buffered-by-newline reader, one
 * synchronous writer. No reconnect, no batching, no compression — these are
 * the responsibilities of the broader transport layer if/when we need them.
 */

import type { Readable, Writable } from 'node:stream';
import type { StreamLike } from './client';

/**
 * Build a `StreamLike` that consumes newline-delimited JSON-RPC messages
 * from `input` and writes to `output`. Both default to `process.stdin` /
 * `process.stdout`, which is the MCP launcher contract.
 *
 * Closing the returned transport ends the reader iterator immediately
 * (pending awaiters resolve to done); writes after close are silently
 * dropped (matches `InMemoryEventBus.publish` post-close behaviour).
 */
export function stdioTransport(input: Readable = process.stdin, output: Writable = process.stdout): StreamLike {
  let buffer = '';
  let closed = false;
  const queue: string[] = [];
  const resolvers: Array<(line: string | null) => void> = [];

  const drain = (chunk: string): void => {
    buffer += chunk;
    while (true) {
      const newlineAt = buffer.indexOf('\n');
      if (newlineAt < 0) return;
      // strip optional CR (CRLF tolerance — Node child processes sometimes emit those on Windows)
      const raw = buffer.slice(0, newlineAt).replace(/\r$/, '');
      buffer = buffer.slice(newlineAt + 1);
      if (raw.length === 0) continue;
      const r = resolvers.shift();
      if (r) r(raw);
      else queue.push(raw);
    }
  };

  const onData = (chunk: Buffer | string): void => {
    drain(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  };
  const onEnd = (): void => {
    closed = true;
    while (resolvers.length) (resolvers.shift() as (s: null) => void)(null);
  };

  input.setEncoding('utf8');
  input.on('data', onData);
  input.on('end', onEnd);
  input.on('close', onEnd);

  return {
    send(line: string): void {
      if (closed) return; // post-close writes drop, matching the bus contract
      // Outbound MCP messages are also line-delimited. `send` is called with a
      // payload that already includes its trailing `\n` from `McpServer.send`.
      output.write(line);
    },
    lines(): AsyncIterable<string> {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<string>> {
              if (queue.length > 0) return { value: queue.shift() as string, done: false };
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
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      while (resolvers.length) (resolvers.shift() as (s: null) => void)(null);
    },
  };
}
