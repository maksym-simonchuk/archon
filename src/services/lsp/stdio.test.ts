import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { lspStdioTransport } from './stdio';
import type { JsonRpcMessage } from '../mcp/protocol';
import { frame } from './server';

/** Collect at most `n` messages. Resolves when iterator ends OR after n. */
async function readN(io: ReturnType<typeof lspStdioTransport>, n: number): Promise<JsonRpcMessage[]> {
  const out: JsonRpcMessage[] = [];
  for await (const m of io.messages()) {
    out.push(m);
    if (out.length >= n) break;
  }
  return out;
}

describe('lspStdioTransport', () => {
  it('parses Content-Length-framed messages from a chunked input', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = lspStdioTransport(input, output);

    // Two messages in one chunk; the decoder must split them on the
    // Content-Length boundary, not on whitespace.
    const a = frame({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const b = frame({ jsonrpc: '2.0', id: 2, method: 'archon/blastRadius', params: { path: 'src/x.ts' } });
    input.write(a);
    input.write(b);

    const msgs = await readN(io, 2);
    expect(msgs).toHaveLength(2);
    // Each message preserves its id + method.
    const m0 = msgs[0] as { id?: number; method?: string };
    const m1 = msgs[1] as { id?: number; method?: string };
    expect(m0.id).toBe(1);
    expect(m1.method).toBe('archon/blastRadius');
    io.close();
  });

  it('reassembles a message split across multiple input chunks', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = lspStdioTransport(input, output);

    const msg = frame({ jsonrpc: '2.0', id: 7, method: 'shutdown' });
    const mid = Math.floor(msg.length / 2);
    input.write(msg.slice(0, mid));
    // Force the decoder to buffer and wait for the rest.
    await new Promise<void>((r) => setImmediate(r));
    input.write(msg.slice(mid));

    const msgs = await readN(io, 1);
    expect((msgs[0] as { method?: string }).method).toBe('shutdown');
    io.close();
  });

  it('forwards send() to the output stream verbatim', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = lspStdioTransport(input, output);
    const chunks: string[] = [];
    output.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));

    const reply = frame({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    io.send(reply);
    await new Promise<void>((r) => setImmediate(r));
    expect(chunks.join('')).toBe(reply);
    io.close();
  });

  it('ends the iterator when the input stream ends', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = lspStdioTransport(input, output);

    input.write(frame({ jsonrpc: '2.0', id: 1, method: 'a' }));
    input.end();

    const msgs: JsonRpcMessage[] = [];
    for await (const m of io.messages()) msgs.push(m);
    expect(msgs).toHaveLength(1);
  });
});
