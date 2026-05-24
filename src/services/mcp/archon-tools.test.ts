import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntime, type Runtime } from '../../runtime';
import { archonReadOnlyTools } from './archon-tools';

const POLICY = readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8');

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function runtime(): Promise<Runtime> {
  dir = await mkdtemp(join(tmpdir(), 'archon-mcp-tools-'));
  await mkdir(join(dir, '.archon'), { recursive: true });
  await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
  return buildRuntime(dir);
}

describe('archonReadOnlyTools', () => {
  it('exposes the four read-only tools, none mutating', async () => {
    const rt = await runtime();
    try {
      const tools = archonReadOnlyTools(rt);
      expect(tools.map((t) => t.desc.name)).toEqual([
        'archon.blastRadius',
        'archon.explain',
        'archon.violations',
        'archon.map',
      ]);
      expect(tools.every((t) => t.mutating === false)).toBe(true);
    } finally {
      rt.close();
    }
  });

  it('returns an empty/zero-value report when the repo has no index yet', async () => {
    const rt = await runtime();
    try {
      const tools = archonReadOnlyTools(rt);
      const byName = new Map(tools.map((t) => [t.desc.name, t]));

      const blast = await byName.get('archon.blastRadius')?.invoke({ target: 'src/missing.ts' });
      // First content block is the JSON envelope; assert against it.
      const blastJson = blast?.content[0];
      expect(blastJson).toMatchObject({
        type: 'json',
        json: { target: 'src/missing.ts', seeds: [], dependents: [], files: [], indexed: false },
      });

      const map = await byName.get('archon.map')?.invoke({});
      expect(map?.content[0]).toMatchObject({
        type: 'json',
        json: { files: 0, symbols: 0, edges: 0, edgesByKind: {}, hot: [] },
      });

      const violations = await byName.get('archon.violations')?.invoke({});
      expect(violations?.content[0]).toMatchObject({
        type: 'json',
        json: { violations: [], healthScore: 100 },
      });

      const explain = await byName.get('archon.explain')?.invoke({ query: 'nope' });
      expect(explain?.content[0]).toMatchObject({
        type: 'json',
        json: { resolved: null, file: null, candidates: [] },
      });
    } finally {
      rt.close();
    }
  });

  it('rejects missing required arguments with a clear error', async () => {
    const rt = await runtime();
    try {
      const tools = archonReadOnlyTools(rt);
      const blast = tools.find((t) => t.desc.name === 'archon.blastRadius');
      // No `target` field → invalid-params error surfaces from requireString.
      await expect(blast?.invoke({})).rejects.toThrow(/missing required argument: target/);
      await expect(blast?.invoke({ target: '' })).rejects.toThrow(/non-empty string/);
    } finally {
      rt.close();
    }
  });

  it('routes through the McpServer and is visible on tools/list', async () => {
    const rt = await runtime();
    try {
      const { McpServer, memoryPipe } = await import('./server');
      const { McpClient } = await import('./client');
      const { a, b } = memoryPipe();
      const server = new McpServer(b, { name: 'archon', version: '1', tools: archonReadOnlyTools(rt) });
      const servePromise = server.serve();
      const client = new McpClient(a, { server: 'archon', authorize: async () => 'allow' });
      await client.initialize();
      const visible = (await client.listTools()).map((t) => t.name);
      expect(visible).toEqual(['archon.blastRadius', 'archon.explain', 'archon.violations', 'archon.map']);
      // Sanity-check a tool round-trip — the empty-index path returns indexed:false.
      const result = await client.callTool('archon.blastRadius', { target: 'whatever' });
      const jsonBlock = result.content.find((c) => c.type === 'json');
      expect(jsonBlock).toBeDefined();
      client.close();
      server.stop();
      await servePromise;
    } finally {
      rt.close();
    }
  });
});
