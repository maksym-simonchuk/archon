/**
 * Stdio transport for the LSP server. Wraps `process.stdin` / `process.stdout`
 * as an `LspTransport`, decoding the standard `Content-Length`-framed
 * JSON-RPC stream via `lspDecoder()` from `./server.ts`.
 *
 * Symmetric to `services/mcp/stdio.ts` but uses LSP framing instead of
 * line-delimited JSON. Close semantics match: end-of-input ends the
 * iterator, post-close writes drop silently.
 */

import type { Readable, Writable } from 'node:stream';
import { lspDecoder } from './server';
import type { LspTransport } from './server';

export function lspStdioTransport(input: Readable = process.stdin, output: Writable = process.stdout): LspTransport {
  const decoder = lspDecoder();
  let closed = false;

  const onData = (chunk: Buffer | string): void => {
    decoder.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  };
  const onEnd = (): void => {
    if (closed) return;
    closed = true;
    decoder.close();
  };

  input.setEncoding('utf8');
  input.on('data', onData);
  input.on('end', onEnd);
  input.on('close', onEnd);

  return {
    send(framed: string): void {
      if (closed) return;
      output.write(framed);
    },
    messages() {
      return decoder.messages;
    },
    close(): void {
      if (closed) return;
      closed = true;
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      decoder.close();
    },
  };
}
