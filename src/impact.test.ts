import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdImpact } from './commands';
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
  dir = await mkdtemp(join(tmpdir(), 'archon-impact-'));
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

describe('archon impact (blast radius)', () => {
  it('reports the dependents of a changed file (reverse reachability)', async () => {
    const rt = await runtime();
    seedGraph(rt.root);
    const log = captured();
    await cmdImpact(rt, 'src/a.ts'); // a is called by b
    const out = text(log);

    expect(out).toContain('impact of src/a.ts');
    expect(out).toContain('1 dependent(s) across 2 file(s)'); // b depends on a → both files in radius
    expect(out).toContain('src/a.ts  (source)');
    expect(out).toContain('src/b.ts');
    rt.close();
  });

  it('a leaf with no dependents affects only its own file', async () => {
    const rt = await runtime();
    seedGraph(rt.root);
    const log = captured();
    await cmdImpact(rt, 'src/b.ts'); // nothing depends on b
    const out = text(log);

    expect(out).toContain('0 dependent(s) across 1 file(s)');
    rt.close();
  });

  it('reports an unknown target without throwing', async () => {
    const rt = await runtime();
    seedGraph(rt.root);
    const log = captured();
    await cmdImpact(rt, 'src/ghost.ts');
    expect(text(log)).toContain('not an indexed file or symbol');
    rt.close();
  });

  it('distinguishes an indexed-but-symbol-less file (e.g. types-only) from an unknown one', async () => {
    const rt = await runtime();
    seedGraph(rt.root);
    const store = new IndexStore(join(rt.root, '.archon/index.db'));
    store.upsertFileHash('src/types.ts', 'deadbeef'); // hashed, but defines zero symbols
    store.close();

    const log = captured();
    await cmdImpact(rt, 'src/types.ts');
    expect(text(log)).toContain('indexed but defines no extractable symbols');
    rt.close();
  });

  it('asks for an index when none exists, creating no db (read-only)', async () => {
    const rt = await runtime();
    const log = captured();
    await cmdImpact(rt, 'src/a.ts');
    expect(text(log)).toContain('no index yet');
    expect(existsSync(join(rt.root, '.archon/index.db'))).toBe(false);
    rt.close();
  });
});
