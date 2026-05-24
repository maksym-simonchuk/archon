import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonRpcMessage, JsonRpcSuccess } from '../mcp/protocol';
import { frame, lspDecoder, type LspTransport } from './server';
import { serveLspStdio } from './serve';

const POLICY = readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8');

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/**
 * Paired in-memory LSP transport. `client` feeds its `send` straight into
 * `server`'s decoder (and vice-versa), so we can drive `serveLspStdio` with
 * the same wire it would see over stdio without spawning a child process.
 * Mirrors what `memoryPipe` does for MCP but adds the Content-Length framing
 * step a real LSP client would do.
 */
function lspPipe(): { client: LspTransport; server: LspTransport } {
  const c = lspDecoder();
  const s = lspDecoder();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    c.close();
    s.close();
  };
  return {
    client: {
      send: (framed) => {
        if (!closed) s.push(framed);
      },
      messages: () => c.messages,
      close,
    },
    server: {
      send: (framed) => {
        if (!closed) c.push(framed);
      },
      messages: () => s.messages,
      close,
    },
  };
}

async function readReply(io: LspTransport, id: number): Promise<JsonRpcSuccess> {
  for await (const msg of io.messages()) {
    const m = msg as JsonRpcMessage & { id?: number };
    if (m.id === id && 'result' in m) return m as JsonRpcSuccess;
  }
  throw new Error(`no reply for id ${id}`);
}

describe('serveLspStdio (archon lsp entry point)', () => {
  async function scaffold(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'archon-lsp-serve-'));
    await mkdir(join(dir, '.archon'), { recursive: true });
    await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
    return dir;
  }

  it('answers initialize with the archon capability set', async () => {
    const root = await scaffold();
    const { client, server } = lspPipe();
    const served = serveLspStdio(root, server);

    client.send(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    const reply = await readReply(client, 1);
    const r = reply.result as { serverInfo: { name: string }; capabilities: { executeCommandProvider: { commands: string[] } } };
    expect(r.serverInfo.name).toBe('archon-lsp');
    // The capability set is part of the wire contract — drift here means an
    // editor binding may stop working; bump intentionally.
    expect(r.capabilities.executeCommandProvider.commands).toContain('archon.blastRadius');

    client.send(frame({ jsonrpc: '2.0', id: 2, method: 'exit' }));
    client.close();
    await served;
  });

  it('answers archon/blastRadius against an empty repo with empty arrays', async () => {
    const root = await scaffold();
    const { client, server } = lspPipe();
    const served = serveLspStdio(root, server);

    // No index → the LSP handler's compute primitive returns empty shape.
    client.send(frame({ jsonrpc: '2.0', id: 1, method: 'archon/blastRadius', params: { path: 'src/x.ts' } }));
    const reply = await readReply(client, 1);
    const r = reply.result as { files: string[]; symbols: string[] };
    expect(r.files).toEqual([]);
    expect(r.symbols).toEqual([]);

    client.send(frame({ jsonrpc: '2.0', id: 2, method: 'exit' }));
    client.close();
    await served;
  });
});
