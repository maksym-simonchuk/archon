import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntime, type Runtime } from '../../runtime';
import { archonLspHandlers } from './archon-handlers';

const POLICY = readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8');

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function runtime(): Promise<Runtime> {
  dir = await mkdtemp(join(tmpdir(), 'archon-lsp-handlers-'));
  await mkdir(join(dir, '.archon'), { recursive: true });
  await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
  return buildRuntime(dir);
}

describe('archonLspHandlers', () => {
  it('blastRadius returns the LSP-trimmed envelope (files + symbols only)', async () => {
    const rt = await runtime();
    try {
      const h = archonLspHandlers(rt);
      const out = await h.blastRadius({ path: 'src/missing.ts' });
      // Empty index → empty arrays. Crucially, the LSP shape has just
      // `files` and `symbols` — no `target`/`indexed` leak from the MCP shape.
      expect(Object.keys(out).sort()).toEqual(['files', 'symbols']);
      expect(out.files).toEqual([]);
      expect(out.symbols).toEqual([]);
    } finally {
      rt.close();
    }
  });

  it('explain renders unknown symbols as a summary + empty neighbours', async () => {
    const rt = await runtime();
    try {
      const h = archonLspHandlers(rt);
      const out = await h.explain({ symbol: 'nope' });
      expect(out.summary).toMatch(/not indexed/);
      expect(out.neighbours).toEqual([]);
    } finally {
      rt.close();
    }
  });

  it('violations returns LSP diagnostics shaped with severity + range', async () => {
    const rt = await runtime();
    try {
      const h = archonLspHandlers(rt);
      const out = await h.violations({});
      // Empty index → no violations. Shape assertion validates the mapping.
      expect(Array.isArray(out)).toBe(true);
      for (const d of out) {
        expect([1, 2, 3, 4]).toContain(d.severity);
        expect(d.source).toBe('archon');
        expect(d.range.start).toEqual({ line: 0, character: 0 });
      }
    } finally {
      rt.close();
    }
  });

  it('rejects missing/empty arguments with a clear error', async () => {
    const rt = await runtime();
    try {
      const h = archonLspHandlers(rt);
      await expect(h.blastRadius({ path: '' })).rejects.toThrow(/empty `path`/);
      await expect(h.explain({ symbol: '' })).rejects.toThrow(/empty `symbol`/);
    } finally {
      rt.close();
    }
  });

  it('executeCommand routes to the bound read-only verbs', async () => {
    const rt = await runtime();
    try {
      const h = archonLspHandlers(rt);
      const blast = await h.executeCommand('archon.blastRadius', [{ path: 'src/missing.ts' }]);
      expect(blast).toMatchObject({ files: [], symbols: [] });
      const expl = await h.executeCommand('archon.explain', [{ symbol: 'whatever' }]);
      expect(expl).toMatchObject({ summary: expect.stringMatching(/not indexed/) });
    } finally {
      rt.close();
    }
  });

  it('executeCommand refuses unbound commands (read-only surface only)', async () => {
    const rt = await runtime();
    try {
      const h = archonLspHandlers(rt);
      await expect(h.executeCommand('archon.write', [])).rejects.toThrow(/not bound/);
    } finally {
      rt.close();
    }
  });
});
