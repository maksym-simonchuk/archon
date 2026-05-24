import { describe, expect, it } from 'vitest';
import type { JsonRpcMessage, JsonRpcSuccess } from '../mcp/protocol';
import { ArchonLspServer, frame, lspDecoder, type LspTransport } from './server';

const handlers = {
  blastRadius: async (args: { path: string }) => ({ files: [args.path], symbols: [`${args.path}#main`] }),
  explain: async (args: { symbol: string }) => ({ summary: `explain ${args.symbol}`, neighbours: [] }),
  violations: async () => [],
  executeCommand: async (cmd: string) => ({ cmd }),
};

const inMemoryTransport = (): { server: LspTransport; sentByServer: string[]; pushToServer: (m: JsonRpcMessage) => void; close: () => void } => {
  const sent: string[] = [];
  const decoder = lspDecoder();
  return {
    sentByServer: sent,
    server: {
      send: (framed) => sent.push(framed),
      messages: () => decoder.messages,
      close: () => decoder.close(),
    },
    pushToServer: (m) => decoder.push(frame(m)),
    close: () => decoder.close(),
  };
};

describe('LSP server', () => {
  it('responds to initialize with capability descriptor', async () => {
    const t = inMemoryTransport();
    const server = new ArchonLspServer(t.server, handlers);
    const sp = server.serve();
    t.pushToServer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    // Drain one response then shutdown.
    await new Promise((r) => setTimeout(r, 5));
    t.pushToServer({ jsonrpc: '2.0', id: 2, method: 'exit' });
    await sp;
    expect(t.sentByServer.length).toBeGreaterThanOrEqual(1);
    const body = (t.sentByServer[0] as string).split('\r\n\r\n')[1];
    const msg = JSON.parse(body as string) as JsonRpcSuccess<{ serverInfo: { name: string } }>;
    expect(msg.result.serverInfo.name).toBe('archon-lsp');
  });

  it('routes archon/blastRadius to the handler', async () => {
    const t = inMemoryTransport();
    const server = new ArchonLspServer(t.server, handlers);
    const sp = server.serve();
    t.pushToServer({ jsonrpc: '2.0', id: 1, method: 'archon/blastRadius', params: { path: 'src/x.ts' } });
    await new Promise((r) => setTimeout(r, 5));
    t.pushToServer({ jsonrpc: '2.0', id: 2, method: 'exit' });
    await sp;
    const reply = t.sentByServer[0] as string;
    const body = JSON.parse(reply.split('\r\n\r\n')[1] as string) as JsonRpcSuccess<{ files: string[] }>;
    expect(body.result.files).toEqual(['src/x.ts']);
  });

  it('frames + decodes round-trip', () => {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const framed = frame(msg);
    expect(framed).toContain('Content-Length:');
    const decoder = lspDecoder();
    decoder.push(framed);
    let received: JsonRpcMessage | null = null;
    void (async () => {
      for await (const m of decoder.messages) {
        received = m;
        break;
      }
    })();
    // Pump microtasks.
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        decoder.close();
        expect(received).toBeDefined();
        expect((received as JsonRpcMessage & { method: string }).method).toBe('ping');
        resolve();
      }, 5),
    );
  });
});
