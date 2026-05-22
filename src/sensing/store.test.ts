import { describe, expect, it } from 'vitest';
import { IndexStore } from './store';

describe('IndexStore', () => {
  it('upserts and reads file hashes', () => {
    const store = new IndexStore(':memory:');
    expect(store.getFileHash('a.ts')).toBeUndefined();
    store.upsertFileHash('a.ts', 'h1');
    expect(store.getFileHash('a.ts')).toBe('h1');
    store.upsertFileHash('a.ts', 'h2'); // upsert overwrites
    expect(store.getFileHash('a.ts')).toBe('h2');
    store.close();
  });

  it('replaces a file graph rather than appending to it', () => {
    const store = new IndexStore(':memory:');
    store.replaceFileGraph(
      'a.ts',
      [{ name: 'a', kind: 'function' }],
      [{ src: 'a', dst: 'b', kind: 'calls' }],
    );
    expect(store.loadEdges()).toEqual([{ src: 'a', dst: 'b', kind: 'calls' }]);

    store.replaceFileGraph(
      'a.ts',
      [{ name: 'a', kind: 'function' }],
      [{ src: 'a', dst: 'c', kind: 'calls' }],
    );
    expect(store.loadEdges()).toEqual([{ src: 'a', dst: 'c', kind: 'calls' }]);
    expect(store.filesForSymbols(['a'])).toEqual(['a.ts']);
    expect(store.filesForSymbols([])).toEqual([]);
    store.close();
  });

  it('round-trips the architectural fingerprint (single row, overwrites)', () => {
    const store = new IndexStore(':memory:');
    expect(store.getFingerprint()).toBeUndefined();

    store.saveFingerprint({
      scannedAt: '2026-01-01T00:00:00.000Z',
      inputHash: 'h1',
      layout: 'single',
      packageManager: 'npm',
      workspaces: [],
      languages: ['typescript'],
      buildSystem: ['tsc'],
      ci: [],
      frameworks: [],
      testRunners: ['vitest'],
      entryPoints: ['src/index.ts'],
      architecturalStyle: 'modular-monolith',
      topDirectories: ['core', 'sensing'],
    });
    expect(store.getFingerprint()).toMatchObject({ inputHash: 'h1', packageManager: 'npm' });

    store.saveFingerprint({
      scannedAt: '2026-02-02T00:00:00.000Z',
      inputHash: 'h2',
      layout: 'monorepo',
      packageManager: 'pnpm',
      workspaces: ['packages/*'],
      languages: ['typescript'],
      buildSystem: ['tsc'],
      ci: [],
      frameworks: [],
      testRunners: [],
      entryPoints: [],
      architecturalStyle: 'feature-sliced',
      topDirectories: [],
    });
    expect(store.getFingerprint()).toMatchObject({ inputHash: 'h2', packageManager: 'pnpm' });
    store.close();
  });

  it('replaces a file import slice rather than appending to it', () => {
    const store = new IndexStore(':memory:');
    store.replaceFileImports('a.ts', ['b.ts', 'c.ts']);
    expect(store.loadFileEdges()).toEqual([
      { src: 'a.ts', dst: 'b.ts' },
      { src: 'a.ts', dst: 'c.ts' },
    ]);

    store.replaceFileImports('a.ts', ['d.ts']); // overwrites only a.ts's slice
    expect(store.loadFileEdges()).toEqual([{ src: 'a.ts', dst: 'd.ts' }]);
    store.close();
  });

  it('round-trips the module intelligence layer (single row, overwrites)', () => {
    const store = new IndexStore(':memory:');
    expect(store.loadModuleIntelligence()).toBeUndefined();

    store.saveModuleIntelligence({
      modules: [{ name: 'src/core', files: 4, fanIn: 9, fanOut: 1, instability: 0.1, role: 'core' }],
      couplingHotspots: [{ name: 'src/core', coupling: 10 }],
      godModules: [],
      cycles: [],
    });
    expect(store.loadModuleIntelligence()?.modules[0]).toMatchObject({ name: 'src/core', role: 'core' });

    store.saveModuleIntelligence({ modules: [], couplingHotspots: [], godModules: [], cycles: [['a', 'b']] });
    expect(store.loadModuleIntelligence()).toMatchObject({ modules: [], cycles: [['a', 'b']] });
    store.close();
  });

  it('appends health snapshots and reads them back oldest-first (M15 trend)', () => {
    const store = new IndexStore(':memory:');
    expect(store.loadHealthHistory()).toEqual([]);

    store.appendHealthSnapshot({ ts: '2026-01-01T00:00:00Z', inputHash: 'h1', score: 88, high: 1, medium: 2, low: 4 });
    store.appendHealthSnapshot({ ts: '2026-02-01T00:00:00Z', inputHash: 'h2', score: 92, high: 0, medium: 2, low: 4 });

    const history = store.loadHealthHistory();
    expect(history.map((s) => s.inputHash)).toEqual(['h1', 'h2']); // append order preserved
    expect(history[0]).toMatchObject({ score: 88, high: 1, medium: 2, low: 4 });
    expect(history[1].score - history[0].score).toBe(4); // the trend delta
    store.close();
  });

  it('removeFile clears the hash and the whole graph slice', () => {
    const store = new IndexStore(':memory:');
    store.upsertFileHash('a.ts', 'h1');
    store.replaceFileGraph(
      'a.ts',
      [{ name: 'a', kind: 'function' }],
      [{ src: 'a', dst: 'b', kind: 'calls' }],
    );
    store.replaceFileImports('a.ts', ['b.ts']);
    store.removeFile('a.ts');
    expect(store.getFileHash('a.ts')).toBeUndefined();
    expect(store.loadEdges()).toEqual([]);
    expect(store.loadFileEdges()).toEqual([]);
    expect(store.filesForSymbols(['a'])).toEqual([]);
    store.close();
  });
});
