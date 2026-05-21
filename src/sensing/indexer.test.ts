import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { ComputeCore } from '../core/compute';
import { Indexer } from './indexer';
import { IndexStore } from './store';
import { SymbolGraph } from './symbol-graph';

/** Stand-in for the Rust/WASM core: hashes by byte length, returns a canned parse. */
const fakeCore = (): ComputeCore => ({
  hashFiles: async (files) => files.map((f) => ({ path: f.path, hash: `h:${f.bytes.length}` })),
  parseSymbols: async () => ({
    symbols: [{ name: 'foo', kind: 'function' }],
    edges: [{ src: 'foo', dst: 'bar', kind: 'calls' }],
  }),
  rankRepoMap: async () => [],
  cosineTopK: async () => [],
});

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('Indexer', () => {
  it('dirtyPaths reports working-tree changes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-idx-'));
    await simpleGit(dir).init();
    await writeFile(join(dir, 'foo.ts'), 'abc');

    const store = new IndexStore(':memory:');
    const indexer = new Indexer(fakeCore(), store, new SymbolGraph(store), dir);

    expect(await indexer.dirtyPaths()).toContain('foo.ts');
  });

  it('reindex hashes + parses changed files and persists the graph', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-idx-'));
    await writeFile(join(dir, 'foo.ts'), 'abc'); // 3 bytes

    const store = new IndexStore(':memory:');
    const graph = new SymbolGraph(store);
    const indexer = new Indexer(fakeCore(), store, graph, dir);

    await indexer.reindex(['foo.ts']);
    expect(store.getFileHash('foo.ts')).toBe('h:3');

    // foo calls bar, so a change to bar puts foo in the blast radius.
    const radius = await graph.blastRadius(['bar']);
    expect(radius.symbols).toContain('foo');
    expect(radius.files).toContain('foo.ts');

    // Re-running with identical content is a no-op (exercises skip-unchanged).
    await indexer.reindex(['foo.ts']);
    expect(store.getFileHash('foo.ts')).toBe('h:3');
  });

  it('reindex drops the slice for a path that no longer exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-idx-'));
    const file = join(dir, 'foo.ts');
    await writeFile(file, 'abc');

    const store = new IndexStore(':memory:');
    const graph = new SymbolGraph(store);
    const indexer = new Indexer(fakeCore(), store, graph, dir);

    await indexer.reindex(['foo.ts']);
    expect(store.getFileHash('foo.ts')).toBe('h:3');

    await rm(file); // git still reports it dirty (deleted), but it's gone on disk
    await indexer.reindex(['foo.ts']);
    expect(store.getFileHash('foo.ts')).toBeUndefined();
    expect(await graph.blastRadius(['bar'])).toMatchObject({ symbols: ['bar'], files: [] });
  });
});
