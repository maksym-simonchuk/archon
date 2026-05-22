import { describe, expect, it } from 'vitest';
import type { ArchitecturalFingerprint } from '../core/types';
import type { BoundaryModel, ModuleNode } from '../sensing/boundaries';
import type { PhilosophyProfile } from '../sensing/philosophy';
import { formatAgents, generateAgents } from './agent-factory';

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
  testRunners: [],
  entryPoints: [],
  architecturalStyle: 'modular-monolith',
  topDirectories: [],
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

const model = (over: Partial<BoundaryModel> = {}): BoundaryModel => ({
  modules: [mod({ name: 'src/app', role: 'core' })],
  couplingHotspots: [],
  godModules: [],
  cycles: [],
  ...over,
});

const philosophy: PhilosophyProfile = {
  typingStrictness: 'strict',
  abstractionTolerance: 'moderate',
  layeringStyle: 'modular-monolith',
  stabilityBias: 'balanced',
  scale: 'growth',
  naming: 'kebab-case',
  colocatedTests: true,
  rationale: [],
};

const ids = (fingerprint: ArchitecturalFingerprint, m = model()): string[] =>
  generateAgents(fingerprint, m, philosophy).map((a) => a.id);

describe('generateAgents', () => {
  it('always emits an architecture-review agent', () => {
    expect(ids(fp())).toContain('architecture-review-agent');
  });

  it('emits a routing agent for Next.js and a state agent for React', () => {
    const out = ids(fp({ frameworks: ['next', 'react'] }), model({ modules: [mod({ name: 'src/app', role: 'core' })] }));
    expect(out).toContain('nextjs-routing-agent');
    expect(out).toContain('state-management-agent');
  });

  it('emits an api-contract agent for a backend framework', () => {
    expect(ids(fp({ frameworks: ['nestjs'] }))).toContain('api-contract-agent');
  });

  it('emits a feature-boundary enforcer only for sliced/ddd layouts', () => {
    expect(ids(fp({ architecturalStyle: 'feature-sliced' }))).toContain('feature-boundary-enforcer');
    expect(ids(fp({ architecturalStyle: 'flat' }))).not.toContain('feature-boundary-enforcer');
  });

  it('emits a dependency-cleanup agent only when there are cycles or god modules', () => {
    expect(ids(fp())).not.toContain('dependency-cleanup-agent');
    expect(ids(fp(), model({ cycles: [['a', 'b']] }))).toContain('dependency-cleanup-agent');
  });

  it('emits a testing agent when a test runner is present', () => {
    expect(ids(fp({ testRunners: ['vitest'] }))).toContain('testing-agent');
  });

  it('never produces duplicate agent ids', () => {
    const out = ids(fp({ frameworks: ['react', 'vue'] }));
    expect(new Set(out).size).toBe(out.length);
  });

  it('scopes capabilities — the review agent is read-only', () => {
    const review = generateAgents(fp(), model(), philosophy).find((a) => a.id === 'architecture-review-agent');
    expect(review?.capabilities).toEqual(['fs.read']);
  });
});

describe('formatAgents', () => {
  it('renders a roster, and a hint when empty', () => {
    expect(formatAgents([])).toContain('none generated');
    expect(formatAgents(generateAgents(fp({ frameworks: ['next'] }), model(), philosophy))).toContain('nextjs-routing-agent');
  });
});
