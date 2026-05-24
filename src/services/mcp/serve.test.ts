import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpClient } from './client';
import { memoryPipe } from './server';
import { serveMcpStdio } from './serve';

const POLICY = readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8');

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/**
 * End-to-end smoke for `archon mcp` (the production stdio MCP server entry):
 * builds a real runtime, exposes the read-only tool surface, and answers a
 * full JSON-RPC handshake (`initialize` + `tools/list` + `tools/call`) over
 * the same paired in-memory transport an editor would otherwise see over
 * stdio. The point is to lock down the *wiring* — that `serveMcpStdio`
 * actually loads `archonReadOnlyTools(rt)` and stays read-only.
 */
describe('serveMcpStdio (archon mcp entry point)', () => {
  async function scaffold(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'archon-mcp-serve-'));
    await mkdir(join(dir, '.archon'), { recursive: true });
    await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
    return dir;
  }

  it('exposes the read-only tool surface end-to-end (initialize + tools/list)', async () => {
    const root = await scaffold();
    const { a, b } = memoryPipe();
    // Drive the server in the background; the test resolves it by closing
    // its end of the pipe (matches the SIGPIPE/parent-close exit path).
    const served = serveMcpStdio(root, b);

    const client = new McpClient(a, { server: 'test', authorize: async () => 'allow' });
    const init = await client.initialize();
    expect(init.serverInfo.name).toBe('archon');
    const tools = await client.listTools();
    // The substrate exports four read-only tools (ADR-0020) — drift here means
    // the inbound surface changed; bump the contract intentionally.
    expect(tools.map((t) => t.name).sort()).toEqual([
      'archon.blastRadius',
      'archon.explain',
      'archon.map',
      'archon.violations',
    ]);

    client.close();
    a.close();
    await served;
  });

  it('answers a tool call against an empty repo with a zero-value envelope', async () => {
    const root = await scaffold();
    const { a, b } = memoryPipe();
    const served = serveMcpStdio(root, b);

    const client = new McpClient(a, { server: 'test', authorize: async () => 'allow' });
    await client.initialize();
    // No index yet → the existsSync guard returns the empty shape (per
    // archon-tools.ts `withIndex`). The wire round-trips a structured
    // McpCallToolResult, not an error.
    const result = await client.callTool('archon.blastRadius', { target: 'src/x.ts' });
    expect(result.isError).toBeFalsy();
    expect(Array.isArray(result.content)).toBe(true);

    client.close();
    a.close();
    await served;
  });
});
