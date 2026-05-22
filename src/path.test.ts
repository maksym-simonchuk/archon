import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdPath } from './commands';
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
  dir = await mkdtemp(join(tmpdir(), 'archon-path-'));
  await mkdir(join(dir, '.archon'), { recursive: true });
  await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
  return buildRuntime(dir);
}

/** Seed a chain a → b → c (a depends on b, b depends on c). */
function seedChain(root: string): void {
  const store = new IndexStore(join(root, '.archon/index.db'));
  store.replaceFileGraph(
    'src/a.ts',
    [{ name: 'src/a.ts#a', kind: 'function' }],
    [{ src: 'src/a.ts#a', dst: 'src/b.ts#b', kind: 'calls' }],
  );
  store.replaceFileGraph(
    'src/b.ts',
    [{ name: 'src/b.ts#b', kind: 'function' }],
    [{ src: 'src/b.ts#b', dst: 'src/c.ts#c', kind: 'calls' }],
  );
  store.replaceFileGraph('src/c.ts', [{ name: 'src/c.ts#c', kind: 'function' }], []);
  store.close();
}

const captured = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
const text = (log: ReturnType<typeof captured>): string => log.mock.calls.flat().join('\n');

describe('archon path (dependency chain)', () => {
  it('traces the shortest chain along dependency edges', async () => {
    const rt = await runtime();
    seedChain(rt.root);
    const log = captured();
    await cmdPath(rt, 'src/a.ts#a', 'src/c.ts#c');
    const out = text(log);

    expect(out).toContain('2 hop(s)');
    expect(out).toContain('src/a.ts#a → src/b.ts#b → src/c.ts#c');
    rt.close();
  });

  it('reports no path against the dependency direction', async () => {
    const rt = await runtime();
    seedChain(rt.root);
    const log = captured();
    await cmdPath(rt, 'src/c.ts#c', 'src/a.ts#a'); // c does not depend on a
    expect(text(log)).toContain('does not transitively depend on');
    rt.close();
  });

  it('resolves bare names at both endpoints', async () => {
    const rt = await runtime();
    seedChain(rt.root);
    const log = captured();
    await cmdPath(rt, 'a', 'c'); // bare → qualified
    expect(text(log)).toContain('src/a.ts#a → src/b.ts#b → src/c.ts#c');
    rt.close();
  });

  it('reports an unknown endpoint', async () => {
    const rt = await runtime();
    seedChain(rt.root);
    const log = captured();
    await cmdPath(rt, 'a', 'ghost');
    expect(text(log)).toContain('to "ghost" is not an indexed symbol');
    rt.close();
  });

  it('treats a symbol as reaching itself in zero hops', async () => {
    const rt = await runtime();
    seedChain(rt.root);
    const log = captured();
    await cmdPath(rt, 'src/a.ts#a', 'src/a.ts#a');
    expect(text(log)).toContain('0 hop(s)');
    rt.close();
  });

  it('asks for an index when none exists, creating no db (read-only)', async () => {
    const rt = await runtime();
    const log = captured();
    await cmdPath(rt, 'a', 'c');
    expect(text(log)).toContain('no index yet');
    expect(existsSync(join(rt.root, '.archon/index.db'))).toBe(false);
    rt.close();
  });
});
