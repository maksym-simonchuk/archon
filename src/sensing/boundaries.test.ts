import { describe, expect, it } from 'vitest';
import { type BoundaryModel, formatBoundaries, inferBoundaries } from './boundaries';

const mod = (m: BoundaryModel, name: string) => m.modules.find((x) => x.name === name);

describe('inferBoundaries', () => {
  it('clusters files into directory modules and counts them', () => {
    const m = inferBoundaries(
      [{ path: 'src/a/x.ts' }, { path: 'src/a/y.ts' }, { path: 'src/b/z.ts' }, { path: 'top.ts' }],
      [],
    );
    expect(mod(m, 'src/a')?.files).toBe(2);
    expect(mod(m, 'src/b')?.files).toBe(1);
    expect(mod(m, '(root)')?.files).toBe(1);
    // No edges → every module isolated, no hotspots/cycles.
    expect(m.modules.every((x) => x.role === 'isolated')).toBe(true);
    expect(m.couplingHotspots).toEqual([]);
    expect(m.cycles).toEqual([]);
  });

  it('lifts file edges to module edges, dropping intra-module ones', () => {
    const m = inferBoundaries(
      [{ path: 'src/a/x.ts' }, { path: 'src/a/y.ts' }, { path: 'src/b/z.ts' }],
      [
        { src: 'src/a/x.ts', dst: 'src/a/y.ts' }, // intra-module → dropped
        { src: 'src/a/x.ts', dst: 'src/b/z.ts' }, // a → b
      ],
    );
    expect(mod(m, 'src/a')).toMatchObject({ fanOut: 1, fanIn: 0 });
    expect(mod(m, 'src/b')).toMatchObject({ fanIn: 1, fanOut: 0 });
  });

  it('computes instability and assigns core vs unstable roles', () => {
    // core ← a, b, c all import it; core imports nothing. a/b/c each import only core.
    const m = inferBoundaries(
      [{ path: 'core/c.ts' }, { path: 'a/a.ts' }, { path: 'b/b.ts' }, { path: 'c/c.ts' }],
      [
        { src: 'a/a.ts', dst: 'core/c.ts' },
        { src: 'b/b.ts', dst: 'core/c.ts' },
        { src: 'c/c.ts', dst: 'core/c.ts' },
      ],
    );
    expect(mod(m, 'core')).toMatchObject({ fanIn: 3, fanOut: 0, instability: 0, role: 'core' });
    expect(mod(m, 'a')).toMatchObject({ fanIn: 0, fanOut: 1, instability: 1, role: 'unstable' });
  });

  it('ranks coupling hotspots by total coupling', () => {
    const m = inferBoundaries(
      [{ path: 'hub/h.ts' }, { path: 'x/x.ts' }, { path: 'y/y.ts' }],
      [
        { src: 'x/x.ts', dst: 'hub/h.ts' },
        { src: 'y/y.ts', dst: 'hub/h.ts' },
        { src: 'hub/h.ts', dst: 'x/x.ts' },
      ],
    );
    expect(m.couplingHotspots[0]).toEqual({ name: 'hub', coupling: 3 }); // in:2 out:1
  });

  it('flags a god-module candidate (≥3 in and ≥3 out)', () => {
    const edges = [
      // god imported by a,b,c and imports d,e,f
      { src: 'a/a.ts', dst: 'god/g.ts' },
      { src: 'b/b.ts', dst: 'god/g.ts' },
      { src: 'c/c.ts', dst: 'god/g.ts' },
      { src: 'god/g.ts', dst: 'd/d.ts' },
      { src: 'god/g.ts', dst: 'e/e.ts' },
      { src: 'god/g.ts', dst: 'f/f.ts' },
    ];
    const files = ['a/a', 'b/b', 'c/c', 'd/d', 'e/e', 'f/f', 'god/g'].map((p) => ({ path: `${p}.ts` }));
    const m = inferBoundaries(files, edges);
    expect(m.godModules.map((g) => g.name)).toEqual(['god']);
    expect(m.godModules[0].coupling).toBe(6);
  });

  it('detects a module-level dependency cycle (SCC)', () => {
    const m = inferBoundaries(
      [{ path: 'a/a.ts' }, { path: 'b/b.ts' }, { path: 'c/c.ts' }],
      [
        { src: 'a/a.ts', dst: 'b/b.ts' },
        { src: 'b/b.ts', dst: 'a/a.ts' }, // a ↔ b cycle
        { src: 'b/b.ts', dst: 'c/c.ts' }, // c is acyclic
      ],
    );
    expect(m.cycles).toEqual([['a', 'b']]);
  });
});

describe('formatBoundaries', () => {
  it('reports the empty case', () => {
    expect(formatBoundaries({ modules: [], couplingHotspots: [], godModules: [], cycles: [] })).toContain(
      'no indexed files yet',
    );
  });

  it('renders contexts, hotspots, and a "none" line when there are no cycles', () => {
    const m = inferBoundaries(
      [{ path: 'core/c.ts' }, { path: 'a/a.ts' }],
      [{ src: 'a/a.ts', dst: 'core/c.ts' }],
    );
    const out = formatBoundaries(m);
    expect(out).toContain('bounded contexts');
    expect(out).toContain('coupling hotspots:');
    expect(out).toContain('circular dependencies: none');
  });
});
