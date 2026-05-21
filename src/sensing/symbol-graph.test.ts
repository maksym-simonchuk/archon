import { describe, expect, it } from 'vitest';
import { IndexStore } from './store';
import { SymbolGraph } from './symbol-graph';

describe('SymbolGraph.blastRadius', () => {
  it('returns reverse-reachable dependents and their files', async () => {
    const store = new IndexStore(':memory:');
    const graph = new SymbolGraph(store);
    // a defined in a.ts; b (b.ts) calls a; c (c.ts) calls b.
    graph.applyParse('a.ts', { symbols: [{ name: 'a', kind: 'function' }], edges: [] });
    graph.applyParse('b.ts', {
      symbols: [{ name: 'b', kind: 'function' }],
      edges: [{ src: 'b', dst: 'a', kind: 'calls' }],
    });
    graph.applyParse('c.ts', {
      symbols: [{ name: 'c', kind: 'function' }],
      edges: [{ src: 'c', dst: 'b', kind: 'calls' }],
    });

    const radius = await graph.blastRadius(['a']);
    expect(new Set(radius.symbols)).toEqual(new Set(['a', 'b', 'c']));
    expect(new Set(radius.files)).toEqual(new Set(['a.ts', 'b.ts', 'c.ts']));
    expect(radius.escapesRepo).toBe(false);
    store.close();
  });

  it('does not traverse non-dependency edges', async () => {
    const store = new IndexStore(':memory:');
    const graph = new SymbolGraph(store);
    graph.applyParse('a.ts', {
      symbols: [{ name: 'a', kind: 'function' }],
      edges: [{ src: 'a', dst: 'x', kind: 'defines' }],
    });
    const radius = await graph.blastRadius(['x']);
    expect(radius.symbols).toEqual(['x']); // 'defines' is not a dependency edge
    store.close();
  });
});
