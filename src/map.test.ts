import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdMap } from './commands';
import { buildRuntime, type Runtime } from './runtime';
import { IndexStore } from './sensing/store';

const POLICY = readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8');

let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function runtime(): Promise<Runtime> {
  dir = await mkdtemp(join(tmpdir(), 'archon-map-'));
  await mkdir(join(dir, '.archon'), { recursive: true });
  await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
  return buildRuntime(dir);
}

/**
 * Seed a graph where `a` is depended on by both b and c, and b by c. Registers a
 * file hash per file too — real indexing records both (hash + graph slice), and
 * the map's file count reads the authoritative hash table.
 */
function seedGraph(root: string): void {
  const store = new IndexStore(join(root, '.archon/index.db'));
  store.upsertFileHash('src/a.ts', 'h-a');
  store.replaceFileGraph('src/a.ts', [{ name: 'src/a.ts#a', kind: 'function' }], []);
  store.upsertFileHash('src/b.ts', 'h-b');
  store.replaceFileGraph(
    'src/b.ts',
    [{ name: 'src/b.ts#b', kind: 'function' }],
    [{ src: 'src/b.ts#b', dst: 'src/a.ts#a', kind: 'calls' }],
  );
  store.upsertFileHash('src/c.ts', 'h-c');
  store.replaceFileGraph(
    'src/c.ts',
    [{ name: 'src/c.ts#c', kind: 'function' }],
    [
      { src: 'src/c.ts#c', dst: 'src/a.ts#a', kind: 'calls' },
      { src: 'src/c.ts#c', dst: 'src/b.ts#b', kind: 'calls' },
    ],
  );
  store.close();
}

const captured = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
const text = (log: ReturnType<typeof captured>): string => log.mock.calls.flat().join('\n');

describe('archon map (graph overview)', () => {
  it('reports the graph size and edge-kind breakdown', async () => {
    const rt = await runtime();
    seedGraph(rt.root);
    const log = captured();
    await cmdMap(rt);
    const out = text(log);

    expect(out).toContain('3 file(s) · 3 symbol(s) · 3 edge(s)');
    expect(out).toContain('3 calls');
    rt.close();
  });

  it('ranks the most depended-on symbol first by distinct dependents', async () => {
    const rt = await runtime();
    seedGraph(rt.root);
    const log = captured();
    await cmdMap(rt);
    const out = text(log);

    expect(out).toContain('src/a.ts#a  ←2'); // a is depended on by b and c
    expect(out).toContain('src/b.ts#b  ←1'); // b only by c
    expect(out.indexOf('src/a.ts#a')).toBeLessThan(out.indexOf('src/b.ts#b')); // a ranks above b
    rt.close();
  });

  it('counts distinct dependents, not call sites (dedup)', async () => {
    const rt = await runtime();
    const store = new IndexStore(join(rt.root, '.archon/index.db'));
    store.upsertFileHash('src/a.ts', 'h-a');
    store.replaceFileGraph('src/a.ts', [{ name: 'src/a.ts#a', kind: 'function' }], []);
    store.upsertFileHash('src/b.ts', 'h-b');
    store.replaceFileGraph(
      'src/b.ts',
      [{ name: 'src/b.ts#b', kind: 'function' }],
      [
        { src: 'src/b.ts#b', dst: 'src/a.ts#a', kind: 'calls' }, // b calls a twice
        { src: 'src/b.ts#b', dst: 'src/a.ts#a', kind: 'calls' },
      ],
    );
    store.close();

    const log = captured();
    await cmdMap(rt);
    expect(text(log)).toContain('src/a.ts#a  ←1'); // one distinct dependent, not two edges
    rt.close();
  });

  it('notes an index that has files but no symbols', async () => {
    const rt = await runtime();
    const store = new IndexStore(join(rt.root, '.archon/index.db'));
    store.upsertFileHash('src/types.ts', 'deadbeef'); // hashed, zero symbols
    store.close();

    const log = captured();
    await cmdMap(rt);
    expect(text(log)).toContain('no symbols yet');
    rt.close();
  });

  it('emits a machine-readable report under --json', async () => {
    const rt = await runtime();
    seedGraph(rt.root);
    const log = captured();
    await cmdMap(rt, { json: true });
    const report = JSON.parse(text(log));

    expect(report.files).toBe(3);
    expect(report.symbols).toBe(3);
    expect(report.edges).toBe(3);
    expect(report.edgesByKind).toEqual({ calls: 3 });
    expect(report.hot[0]).toEqual({ name: 'src/a.ts#a', dependents: 2 }); // most depended-on first
    rt.close();
  });

  it('asks for an index when none exists, creating no db (read-only)', async () => {
    const rt = await runtime();
    const log = captured();
    await cmdMap(rt);
    expect(text(log)).toContain('no index yet');
    expect(existsSync(join(rt.root, '.archon/index.db'))).toBe(false);
    rt.close();
  });
});
