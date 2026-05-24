import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { stdioTransport } from './stdio';

/** Collect at most `n` lines from a StreamLike. Resolves when iterator ends OR after n. */
async function readN(io: ReturnType<typeof stdioTransport>, n: number): Promise<string[]> {
  const out: string[] = [];
  for await (const line of io.lines()) {
    out.push(line);
    if (out.length >= n) break;
  }
  return out;
}

describe('stdioTransport', () => {
  it('reads complete newline-delimited messages and yields them in order', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = stdioTransport(input, output);

    // Drive stdin with two complete lines + a partial one to ensure buffering.
    input.write('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n');
    input.write('{"jsonrpc":"2.0","id":3,"method":"c"}');
    // Flush the trailing message so the iterator sees 3 lines total.
    input.write('\n');

    const lines = await readN(io, 3);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? '{}').id).toBe(1);
    expect(JSON.parse(lines[2] ?? '{}').id).toBe(3);
    io.close();
  });

  it('forwards `send` writes to the output stream verbatim', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = stdioTransport(input, output);
    const chunks: string[] = [];
    output.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));

    io.send('{"jsonrpc":"2.0","id":1,"result":"ok"}\n');
    // Allow the PassThrough's read side to flush.
    await new Promise<void>((r) => setImmediate(r));
    expect(chunks.join('')).toBe('{"jsonrpc":"2.0","id":1,"result":"ok"}\n');
    io.close();
  });

  it('ends the iterator when the input stream ends', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = stdioTransport(input, output);

    input.write('{"id":1}\n');
    input.end();

    const lines: string[] = [];
    for await (const line of io.lines()) lines.push(line);
    expect(lines).toEqual(['{"id":1}']);
  });

  it('drops sends after close (matches the bus contract)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = stdioTransport(input, output);
    const chunks: string[] = [];
    output.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));

    io.close();
    io.send('{"too":"late"}\n');
    await new Promise<void>((r) => setImmediate(r));
    expect(chunks.join('')).toBe('');
  });

  it('tolerates CRLF line endings (Windows child-process default)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = stdioTransport(input, output);

    input.write('{"a":1}\r\n{"b":2}\r\n');
    const lines = await readN(io, 2);
    // The decoder strips the \r so JSON.parse still succeeds.
    expect(JSON.parse(lines[0] ?? '{}').a).toBe(1);
    expect(JSON.parse(lines[1] ?? '{}').b).toBe(2);
    io.close();
  });
});
