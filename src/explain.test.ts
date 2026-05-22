import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdExplain } from './commands';
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
  dir = await mkdtemp(join(tmpdir(), 'archon-explain-'));
  await mkdir(join(dir, '.archon'), { recursive: true });
  await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
  return buildRuntime(dir);
}

/** Seed a tiny graph (b → calls → a) into the on-disk index, then close it. */
function seedGraph(root: string): void {
  const store = new IndexStore(join(root, '.archon/index.db'));
  store.replaceFileGraph('src/a.ts', [{ name: 'src/a.ts#a', kind: 'function' }], []);
  store.replaceFileGraph(
    'src/b.ts',
    [{ name: 'src/b.ts#b', kind: 'function' }],
    [{ src: 'src/b.ts#b', dst: 'src/a.ts#a', kind: 'calls' }], // b depends on a
  );
  store.close();
}

const captured = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
const text = (log: ReturnType<typeof captured>): string => log.mock.calls.flat().join('\n');

describe('archon explain (one-hop neighborhood)', () => {
  it('reports what a symbol directly depends on (forward edges)', async () => {
    const rt = await runtime();
    seedGraph(rt.root);
    const log = captured();
    await cmdExplain(rt, 'src/b.ts#b'); // b calls a
    const out = text(log);

    expect(out).toContain('src/b.ts#b  [function]  defined in src/b.ts');
    expect(out).toContain('depends on (1):');
    expect(out).toContain('- src/a.ts#a  [calls]');
    expect(out).toContain('used by: (none)'); // nothing calls b
    rt.close();
  });

  it('reports what directly depends on a symbol (reverse edges)', async () => {
    const rt = await runtime();
    seedGraph(rt.root);
    const log = captured();
    await cmdExplain(rt, 'src/a.ts#a'); // a is called by b
    const out = text(log);

    expect(out).toContain('depends on: (none)'); // a calls nothing
    expect(out).toContain('used by (1):');
    expect(out).toContain('- src/b.ts#b  [calls]');
    rt.close();
  });

  it('resolves a bare name to its qualified definition', async () => {
    const rt = await runtime();
    seedGraph(rt.root);
    const log = captured();
    await cmdExplain(rt, 'b'); // bare name → src/b.ts#b
    expect(text(log)).toContain('src/b.ts#b  [function]  defined in src/b.ts');
    rt.close();
  });

  it('reports an ambiguous bare name and lists the candidates', async () => {
    const rt = await runtime();
    const store = new IndexStore(join(rt.root, '.archon/index.db'));
    store.replaceFileGraph('src/x.ts', [{ name: 'src/x.ts#helper', kind: 'function' }], []);
    store.replaceFileGraph('src/y.ts', [{ name: 'src/y.ts#helper', kind: 'function' }], []);
    store.close();

    const log = captured();
    await cmdExplain(rt, 'helper'); // defined in two files
    const out = text(log);
    expect(out).toContain('is ambiguous — 2 definitions');
    expect(out).toContain('src/x.ts#helper');
    expect(out).toContain('src/y.ts#helper');
    rt.close();
  });

  it('collapses duplicate edges (multiple call sites) into one neighbor', async () => {
    const rt = await runtime();
    const store = new IndexStore(join(rt.root, '.archon/index.db'));
    store.replaceFileGraph('src/a.ts', [{ name: 'src/a.ts#a', kind: 'function' }], []);
    store.replaceFileGraph(
      'src/b.ts',
      [{ name: 'src/b.ts#b', kind: 'function' }],
      [
        { src: 'src/b.ts#b', dst: 'src/a.ts#a', kind: 'calls' }, // a called from b twice
        { src: 'src/b.ts#b', dst: 'src/a.ts#a', kind: 'calls' },
      ],
    );
    store.close();

    const log = captured();
    await cmdExplain(rt, 'src/a.ts#a');
    expect(text(log)).toContain('used by (1):'); // deduped to one neighbor, not (2)
    rt.close();
  });

  it('reports an unknown symbol without throwing', async () => {
    const rt = await runtime();
    seedGraph(rt.root);
    const log = captured();
    await cmdExplain(rt, 'nope');
    expect(text(log)).toContain('not an indexed symbol');
    rt.close();
  });

  it('emits a machine-readable report under --json for a resolved symbol', async () => {
    const rt = await runtime();
    seedGraph(rt.root);
    const log = captured();
    await cmdExplain(rt, 'src/a.ts#a', { json: true });
    const report = JSON.parse(text(log));

    expect(report.resolved).toBe('src/a.ts#a');
    expect(report.kind).toBe('function');
    expect(report.file).toBe('src/a.ts');
    expect(report.dependedOnBy).toContainEqual({ name: 'src/b.ts#b', kind: 'calls' });
    expect(report.candidates).toEqual([]);
    rt.close();
  });

  it('emits resolved:null with candidates for an ambiguous bare name under --json', async () => {
    const rt = await runtime();
    const store = new IndexStore(join(rt.root, '.archon/index.db'));
    store.replaceFileGraph('src/x.ts', [{ name: 'src/x.ts#helper', kind: 'function' }], []);
    store.replaceFileGraph('src/y.ts', [{ name: 'src/y.ts#helper', kind: 'function' }], []);
    store.close();

    const log = captured();
    await cmdExplain(rt, 'helper', { json: true });
    const report = JSON.parse(text(log));

    expect(report.resolved).toBeNull();
    expect(report.candidates).toEqual(expect.arrayContaining(['src/x.ts#helper', 'src/y.ts#helper']));
    rt.close();
  });

  it('asks for an index when none exists, creating no db (read-only)', async () => {
    const rt = await runtime();
    const log = captured();
    await cmdExplain(rt, 'src/a.ts#a');
    expect(text(log)).toContain('no index yet');
    expect(existsSync(join(rt.root, '.archon/index.db'))).toBe(false);
    rt.close();
  });
});
