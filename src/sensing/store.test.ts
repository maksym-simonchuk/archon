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

  it('removeFile clears the hash and the whole graph slice', () => {
    const store = new IndexStore(':memory:');
    store.upsertFileHash('a.ts', 'h1');
    store.replaceFileGraph(
      'a.ts',
      [{ name: 'a', kind: 'function' }],
      [{ src: 'a', dst: 'b', kind: 'calls' }],
    );
    store.removeFile('a.ts');
    expect(store.getFileHash('a.ts')).toBeUndefined();
    expect(store.loadEdges()).toEqual([]);
    expect(store.filesForSymbols(['a'])).toEqual([]);
    store.close();
  });
});
