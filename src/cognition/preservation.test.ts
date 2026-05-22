import { describe, expect, it } from 'vitest';
import type { ModuleNode } from '../sensing/boundaries';
import type { PhilosophyProfile } from '../sensing/philosophy';
import { assessPreservation, formatPreservation, type PreservationInput } from './preservation';
import type { FileRisk } from './risk';

const mod = (over: Partial<ModuleNode> = {}): ModuleNode => ({
  name: 'src/x',
  files: 3,
  fanIn: 0,
  fanOut: 0,
  instability: 0.5,
  role: 'balanced',
  ...over,
});

const risk = (over: Partial<FileRisk> = {}): FileRisk => ({
  file: 'src/x/a.ts',
  module: 'src/x',
  level: 'medium',
  region: 'evolving',
  neverModify: false,
  blastRadius: 0,
  criticality: 0,
  confidence: 1,
  rationale: [],
  ...over,
});

const philosophy = (over: Partial<PhilosophyProfile> = {}): PhilosophyProfile => ({
  typingStrictness: 'strict',
  abstractionTolerance: 'high',
  layeringStyle: 'ddd',
  stabilityBias: 'stability',
  scale: 'enterprise',
  naming: 'kebab-case',
  colocatedTests: true,
  rationale: [],
  ...over,
});

const input = (over: Partial<PreservationInput> = {}): PreservationInput => ({
  target: 'src/domain/order.ts',
  module: mod({ name: 'src/domain', role: 'core', fanIn: 6 }),
  risk: risk({ region: 'stable', criticality: 6 }),
  philosophy: philosophy(),
  change: 'remove-abstraction',
  ...over,
});

describe('assessPreservation', () => {
  it('preserves an intentional, business-critical structure from a generic de-abstraction', () => {
    const v = assessPreservation(input());
    expect(v.disposition).toBe('preserve');
    expect(v.complexity).toBe('intentional');
    expect(v.abstractionValue).toBe('business-critical');
  });

  it('always preserves a never-modify zone regardless of change kind', () => {
    const v = assessPreservation(input({ change: 'modify', risk: risk({ neverModify: true, level: 'critical' }) }));
    expect(v.disposition).toBe('preserve');
  });

  it('allows refactoring genuine accidental complexity on an isolated island', () => {
    const v = assessPreservation(
      input({
        target: 'src/scratch/tmp.ts',
        module: mod({ name: 'src/scratch', role: 'isolated' }),
        risk: risk({ region: 'experimental', criticality: 0 }),
        change: 'simplify',
      }),
    );
    expect(v.disposition).toBe('allow');
    expect(v.complexity).toBe('accidental');
  });

  it('treats a god module as accidental complexity even when heavily depended on', () => {
    const v = assessPreservation(
      input({ isGodModule: true, change: 'simplify', risk: risk({ region: 'stable', criticality: 8 }) }),
    );
    expect(v.complexity).toBe('accidental');
    expect(v.disposition).toBe('allow');
  });

  it('cautions on a structure-stripping change with unclear signals', () => {
    const v = assessPreservation(
      input({ module: mod({ role: 'balanced' }), risk: risk({ region: 'evolving', criticality: 1 }), change: 'rewrite' }),
    );
    expect(v.complexity).toBe('unclear');
    expect(v.disposition).toBe('caution');
  });

  it('allows a non-stripping modify even on a core module', () => {
    const v = assessPreservation(input({ change: 'modify' }));
    expect(v.disposition).toBe('allow');
  });
});

describe('formatPreservation', () => {
  it('renders the disposition and rationale', () => {
    const out = formatPreservation('src/domain/order.ts', 'remove-abstraction', assessPreservation(input()));
    expect(out).toContain('PRESERVE');
    expect(out).toContain('why:');
  });
});
