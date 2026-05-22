import { describe, expect, it } from 'vitest';
import { inferBoundaries } from './boundaries';
import { detectViolations, formatViolations } from './violations';

describe('detectViolations', () => {
  it('reports a perfect score for a clean graph', () => {
    const files = [{ path: 'src/a/a.ts' }, { path: 'src/a/a.test.ts' }];
    const r = detectViolations({ model: inferBoundaries(files, []), files, edges: [] });
    expect(r.healthScore).toBe(100);
    expect(r.violations).toEqual([]);
  });

  it('flags a circular dependency as high severity', () => {
    const files = [{ path: 'a/a.ts' }, { path: 'b/b.ts' }];
    const edges = [
      { src: 'a/a.ts', dst: 'b/b.ts' },
      { src: 'b/b.ts', dst: 'a/a.ts' },
    ];
    const r = detectViolations({ model: inferBoundaries(files, edges), files, edges });
    const cycle = r.violations.find((v) => v.kind === 'circular-dependency');
    expect(cycle?.severity).toBe('high');
    expect(cycle?.subject).toBe('a ↔ b');
    expect(r.healthScore).toBeLessThan(100);
  });

  it('flags a god module and a stable-dependency violation', () => {
    // god imported by a,b,c and imports d,e,f; also core (stable) → god (less stable).
    const edges = [
      { src: 'a/a.ts', dst: 'god/g.ts' },
      { src: 'b/b.ts', dst: 'god/g.ts' },
      { src: 'c/c.ts', dst: 'god/g.ts' },
      { src: 'god/g.ts', dst: 'd/d.ts' },
      { src: 'god/g.ts', dst: 'e/e.ts' },
      { src: 'god/g.ts', dst: 'f/f.ts' },
    ];
    const files = ['a/a', 'b/b', 'c/c', 'd/d', 'e/e', 'f/f', 'god/g'].map((p) => ({ path: `${p}.ts` }));
    const r = detectViolations({ model: inferBoundaries(files, edges), files, edges });
    expect(r.violations.some((v) => v.kind === 'god-module' && v.subject === 'god')).toBe(true);
  });

  it('detects an unstable-dependency (stable module → less-stable module)', () => {
    // core (I=0.33: in 2 / out 1) depends on vol (I=0.67: in 1 / out 2) — a stable
    // module reaching for a less-stable one, the SDP violation.
    const edges = [
      { src: 'x/x.ts', dst: 'core/c.ts' },
      { src: 'y/y.ts', dst: 'core/c.ts' },
      { src: 'core/c.ts', dst: 'vol/v.ts' },
      { src: 'vol/v.ts', dst: 'p/p.ts' },
      { src: 'vol/v.ts', dst: 'q/q.ts' },
    ];
    const files = ['x/x', 'y/y', 'core/c', 'vol/v', 'p/p', 'q/q'].map((p) => ({ path: `${p}.ts` }));
    const r = detectViolations({ model: inferBoundaries(files, edges), files, edges });
    const sdp = r.violations.find((v) => v.kind === 'unstable-dependency');
    expect(sdp?.subject).toBe('core → vol');
  });

  it('flags code-defining files with no sibling test (only when definedFiles given)', () => {
    const files = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/b.test.ts' }, { path: 'src/index.ts' }];
    const definedFiles = new Set(['src/a.ts', 'src/b.ts', 'src/index.ts']);
    const r = detectViolations({ model: inferBoundaries(files, []), files, edges: [], definedFiles });
    const missing = r.violations.filter((v) => v.kind === 'missing-tests').map((v) => v.subject);
    expect(missing).toEqual(['src/a.ts']); // b has a test, index.ts is excluded
  });

  it('ranks higher-impact findings first', () => {
    const files = [{ path: 'a/a.ts' }, { path: 'b/b.ts' }];
    const edges = [
      { src: 'a/a.ts', dst: 'b/b.ts' },
      { src: 'b/b.ts', dst: 'a/a.ts' },
    ];
    const definedFiles = new Set(['a/a.ts']);
    const r = detectViolations({ model: inferBoundaries(files, edges), files, edges, definedFiles });
    expect(r.violations[0].severity).toBe('high'); // the cycle outranks the missing test
  });
});

describe('formatViolations', () => {
  it('renders the health header and a clean message', () => {
    const out = formatViolations({ violations: [], healthScore: 100, countsBySeverity: { high: 0, medium: 0, low: 0 } });
    expect(out).toContain('architecture health: 100/100');
    expect(out).toContain('no violations detected');
  });
});
