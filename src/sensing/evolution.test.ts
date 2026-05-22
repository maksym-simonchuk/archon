import { describe, expect, it } from 'vitest';
import type { BoundaryModel, ModuleNode } from './boundaries';
import { analyzeEvolution, formatEvolution, parseGitLog } from './evolution';

const mod = (over: Partial<ModuleNode> & { name: string }): ModuleNode => ({
  files: 3,
  fanIn: 0,
  fanOut: 0,
  instability: 0.5,
  role: 'balanced',
  ...over,
});

const model = (modules: ModuleNode[]): BoundaryModel => ({
  modules,
  couplingHotspots: [],
  godModules: [],
  cycles: [],
});

describe('parseGitLog', () => {
  it('splits commits on the NUL-prefixed header and collects touched paths', () => {
    const raw = ['\0abc', '', 'src/a.ts', 'src/b.ts', '\0def', '', 'src/a.ts'].join('\n');
    expect(parseGitLog(raw)).toEqual([
      { hash: 'abc', files: ['src/a.ts', 'src/b.ts'] },
      { hash: 'def', files: ['src/a.ts'] },
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(parseGitLog('')).toEqual([]);
  });
});

describe('analyzeEvolution', () => {
  it('ranks modules by churn × coupling and reports the window size', () => {
    const m = model([
      mod({ name: 'src/hot', fanIn: 2, fanOut: 2 }), // coupling 4
      mod({ name: 'src/cold', fanIn: 1, fanOut: 0 }), // coupling 1
    ]);
    const commits = [
      { hash: '1', files: ['src/hot/a.ts'] },
      { hash: '2', files: ['src/hot/b.ts'] },
      { hash: '3', files: ['src/cold/a.ts'] },
    ];
    const evo = analyzeEvolution(commits, m);
    expect(evo.commitsAnalyzed).toBe(3);
    expect(evo.hotspots[0].name).toBe('src/hot'); // 2 commits × coupling 4 = 8
    expect(evo.hotspots[0].pressure).toBe(8);
  });

  it('counts a commit touching many files in one module once', () => {
    const m = model([mod({ name: 'src/x', fanIn: 1, fanOut: 1 })]);
    const evo = analyzeEvolution([{ hash: '1', files: ['src/x/a.ts', 'src/x/b.ts', 'src/x/c.ts'] }], m);
    expect(evo.hotspots[0].commits).toBe(1);
  });

  it('flags an entangled-both-ways module under heavy churn as trending toward god-object', () => {
    const m = model([
      mod({ name: 'src/grow', fanIn: 2, fanOut: 2 }), // near-god, not yet god
      mod({ name: 'src/quiet', fanIn: 2, fanOut: 2 }), // same shape, low churn
    ]);
    const commits = [
      ...Array.from({ length: 5 }, (_, i) => ({ hash: `g${i}`, files: ['src/grow/a.ts'] })),
      { hash: 'q', files: ['src/quiet/a.ts'] },
    ];
    const evo = analyzeEvolution(commits, m);
    expect(evo.godTrending.map((r) => r.name)).toEqual(['src/grow']);
    expect(evo.godTrending[0].trendingGod).toBe(true);
  });

  it('does not flag an already-god module (it has crossed, not trending)', () => {
    const m = model([mod({ name: 'src/god', fanIn: 4, fanOut: 4 })]);
    const commits = Array.from({ length: 5 }, (_, i) => ({ hash: `${i}`, files: ['src/god/a.ts'] }));
    expect(analyzeEvolution(commits, m).godTrending).toEqual([]);
  });

  it('never flags an isolated, decoupled module however churned', () => {
    const m = model([mod({ name: 'src/lone', fanIn: 0, fanOut: 0, role: 'isolated' })]);
    const commits = Array.from({ length: 9 }, (_, i) => ({ hash: `${i}`, files: ['src/lone/a.ts'] }));
    expect(analyzeEvolution(commits, m).godTrending).toEqual([]);
  });
});

describe('formatEvolution', () => {
  it('renders the trending list when present', () => {
    const m = model([mod({ name: 'src/grow', fanIn: 2, fanOut: 2 })]);
    const commits = Array.from({ length: 3 }, (_, i) => ({ hash: `${i}`, files: ['src/grow/a.ts'] }));
    const out = formatEvolution(analyzeEvolution(commits, m));
    expect(out).toContain('trending toward god-object (1)');
    expect(out).toContain('src/grow');
    expect(out).toContain('pressure');
  });

  it('says so when there is no history', () => {
    expect(formatEvolution({ hotspots: [], godTrending: [], commitsAnalyzed: 0 })).toContain('no commit history');
  });
});
