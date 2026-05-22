import { describe, expect, it } from 'vitest';
import type { ArchitecturalFingerprint } from '../core/types';
import type { BoundaryModel, ModuleNode } from './boundaries';
import { formatPhilosophy, inferPhilosophy, type PhilosophySignals } from './philosophy';

const fp = (over: Partial<ArchitecturalFingerprint> = {}): ArchitecturalFingerprint => ({
  scannedAt: '2026-01-01T00:00:00Z',
  inputHash: 'h',
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
  topDirectories: ['a', 'b', 'c'],
  ...over,
});

const mod = (over: Partial<ModuleNode>): ModuleNode => ({
  name: 'm',
  files: 2,
  fanIn: 1,
  fanOut: 1,
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

const sig = (over: Partial<PhilosophySignals> = {}): PhilosophySignals => ({
  strictTypes: true,
  typed: true,
  testRatio: 0.8,
  fileCount: 120,
  sourceBasenames: ['user-store.ts', 'auth-service.ts', 'context-scope.ts'],
  ...over,
});

describe('inferPhilosophy', () => {
  it('reads strict typing + CI + high coverage as a stability-biased project', () => {
    const p = inferPhilosophy(fp({ ci: ['github-actions'] }), model([mod({})]), sig());
    expect(p.typingStrictness).toBe('strict');
    expect(p.stabilityBias).toBe('stability');
  });

  it('reads untyped, untested, no-CI as speed-biased and untyped', () => {
    const p = inferPhilosophy(
      fp({ languages: ['javascript'] }),
      model([mod({})]),
      sig({ typed: false, strictTypes: false, testRatio: 0.1, fileCount: 20 }),
    );
    expect(p.typingStrictness).toBe('untyped');
    expect(p.stabilityBias).toBe('speed');
    expect(p.scale).toBe('prototype');
  });

  it('treats a DDD layout or high fan-out as high abstraction tolerance', () => {
    const ddd = inferPhilosophy(fp({ architecturalStyle: 'ddd' }), model([mod({})]), sig());
    expect(ddd.abstractionTolerance).toBe('high');
    const hub = inferPhilosophy(
      fp(),
      model([mod({ fanOut: 6, fanIn: 1 }), mod({ name: 'n', fanOut: 5, fanIn: 2 })]),
      sig(),
    );
    expect(hub.abstractionTolerance).toBe('high');
  });

  it('detects kebab-case naming and a monorepo as enterprise scale', () => {
    const p = inferPhilosophy(
      fp({ layout: 'monorepo', workspaces: ['packages/a', 'packages/b'] }),
      model([mod({})]),
      sig(),
    );
    expect(p.naming).toBe('kebab-case');
    expect(p.scale).toBe('enterprise');
  });

  it('falls back to mixed naming when no convention dominates', () => {
    const p = inferPhilosophy(fp(), model([mod({})]), sig({ sourceBasenames: ['UserStore.ts', 'auth_helper.ts', 'x.ts'] }));
    expect(p.naming).toBe('mixed');
  });
});

describe('formatPhilosophy', () => {
  it('renders the axes and rationale', () => {
    const out = formatPhilosophy(inferPhilosophy(fp(), model([mod({})]), sig()));
    expect(out).toContain('project philosophy:');
    expect(out).toContain('typing');
    expect(out).toContain('why:');
  });
});
