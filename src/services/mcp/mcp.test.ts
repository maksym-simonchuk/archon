import { describe, expect, it } from 'vitest';
import { McpClient } from './client';
import { McpServer, memoryPipe, type ServerTool } from './server';

const readTool: ServerTool = {
  desc: { name: 'echo', description: 'returns the input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  mutating: false,
  invoke: async (args) => ({ content: [{ type: 'text', text: String((args as { text: string }).text) }] }),
};

const writeTool: ServerTool = {
  desc: { name: 'mutate', inputSchema: { type: 'object' } },
  mutating: true,
  invoke: async () => ({ content: [{ type: 'text', text: 'mutated' }] }),
};

describe('MCP client ↔ server (in-memory)', () => {
  it('initialize + listTools + callTool round-trips a read-only tool', async () => {
    const { a, b } = memoryPipe();
    const server = new McpServer(b, { name: 'archon', version: '1', tools: [readTool, writeTool] });
    const servePromise = server.serve();
    const client = new McpClient(a, { server: 'archon', authorize: async () => 'allow' });
    const init = await client.initialize();
    expect(init.serverInfo.name).toBe('archon');
    const tools = await client.listTools();
    // mutate is hidden by default — server runs without mutatingEnabled.
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    const result = await client.callTool('echo', { text: 'hi' });
    expect(result.content[0]).toEqual({ type: 'text', text: 'hi' });
    client.close();
    server.stop();
    await servePromise;
  });

  it('broker-denied capabilities fail at the client without hitting the server', async () => {
    const { a, b } = memoryPipe();
    let serverCalled = false;
    const trackingTool: ServerTool = {
      desc: { name: 'echo', inputSchema: { type: 'object' } },
      mutating: false,
      invoke: async () => {
        serverCalled = true;
        return { content: [{ type: 'text', text: 'never' }] };
      },
    };
    const server = new McpServer(b, { name: 'archon', version: '1', tools: [trackingTool] });
    const servePromise = server.serve();
    const client = new McpClient(a, { server: 'archon', authorize: async (cap) => (cap === 'mcp:archon:echo' ? 'deny' : 'allow') });
    await client.initialize();
    await expect(client.callTool('echo', {})).rejects.toThrow(/denied/);
    expect(serverCalled).toBe(false);
    client.close();
    server.stop();
    await servePromise;
  });

  it('mutatingEnabled=true exposes mutating tools through `tools/list`', async () => {
    const { a, b } = memoryPipe();
    const server = new McpServer(b, { name: 'a', version: '1', tools: [readTool, writeTool], mutatingEnabled: true });
    const sp = server.serve();
    const client = new McpClient(a, { server: 'a', authorize: async () => 'allow' });
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'mutate']);
    client.close();
    server.stop();
    await sp;
  });
});
