import { describe, expect, it } from 'vitest';
import type { PreservationVerdict } from './preservation';
import type { FileRisk } from './risk';
import { type SimulationInput, formatSimulation, simulateExecution } from './simulation';

const risk = (over: Partial<FileRisk> = {}): FileRisk => ({
  file: 'src/x.ts',
  module: 'src',
  level: 'low',
  region: 'evolving',
  neverModify: false,
  blastRadius: 0,
  criticality: 0,
  confidence: 1,
  rationale: [],
  ...over,
});

const preservation = (over: Partial<PreservationVerdict> = {}): PreservationVerdict => ({
  disposition: 'allow',
  complexity: 'unclear',
  abstractionValue: 'unclear',
  rationale: [],
  ...over,
});

const input = (over: Partial<SimulationInput> = {}): SimulationInput => ({
  target: 'src/x.ts',
  change: 'modify',
  moduleName: 'src',
  risk: risk(),
  preservation: preservation(),
  dependents: 0,
  impactedFiles: [],
  dependentModules: [],
  inCycle: false,
  cycle: [],
  confidence: 1,
  moduleChurn: 0,
  churnRef: 1,
  ...over,
});

describe('simulateExecution — recommendation', () => {
  it('a locally-contained, well-covered change is AUTO with ~0 regression', () => {
    const r = simulateExecution(input());
    expect(r.recommendation).toBe('auto');
    expect(r.regression.probability).toBe(0);
    expect(r.propagation).toEqual({ dependents: 0, files: 0, modules: 0 });
  });

  it('a never-modify zone is BLOCK regardless of everything else', () => {
    const r = simulateExecution(input({ risk: risk({ neverModify: true, level: 'critical' }) }));
    expect(r.recommendation).toBe('block');
    expect(r.rationale.join(' ')).toMatch(/never-modify/);
  });

  it('a PRESERVE verdict blocks the change', () => {
    const r = simulateExecution(input({ preservation: preservation({ disposition: 'preserve' }) }));
    expect(r.recommendation).toBe('block');
  });

  it('high blast radius + zero coverage drives regression high and escalates to REVIEW', () => {
    const r = simulateExecution(
      input({ dependents: 30, confidence: 0, risk: risk({ level: 'high', criticality: 10, confidence: 0 }), moduleChurn: 10, churnRef: 2 }),
    );
    expect(r.regression.probability).toBeGreaterThanOrEqual(0.6);
    expect(r.recommendation).toBe('review');
  });

  it('a dependency cycle escalates to REVIEW and is reported on the boundary', () => {
    const r = simulateExecution(input({ inCycle: true, cycle: ['src/a', 'src/b'] }));
    expect(r.recommendation).toBe('review');
    expect(r.boundary).toEqual({ inCycle: true, cycle: ['src/a', 'src/b'] });
  });

  it('a preservation CAUTION escalates an otherwise-low change to REVIEW', () => {
    const r = simulateExecution(input({ preservation: preservation({ disposition: 'caution' }) }));
    expect(r.recommendation).toBe('review');
  });
});

describe('simulateExecution — propagation & drift', () => {
  it('flags API-contract drift when other modules depend on the target', () => {
    const r = simulateExecution(
      input({ impactedFiles: ['src/api/a.ts', 'src/ui/b.ts'], dependentModules: ['src/api', 'src/ui'], dependents: 4 }),
    );
    expect(r.contractDrift).toEqual({ drifts: true, modules: ['src/api', 'src/ui'] });
    expect(r.propagation).toEqual({ dependents: 4, files: 2, modules: 2 });
    expect(r.typeImpact).toEqual(['src/api/a.ts', 'src/ui/b.ts']);
  });

  it('regression rises monotonically with reach and falls with coverage', () => {
    const lowReach = simulateExecution(input({ dependents: 2, confidence: 0.5 })).regression.probability;
    const highReach = simulateExecution(input({ dependents: 30, confidence: 0.5 })).regression.probability;
    expect(highReach).toBeGreaterThan(lowReach);
    const wellCovered = simulateExecution(input({ dependents: 30, confidence: 1 })).regression.probability;
    const uncovered = simulateExecution(input({ dependents: 30, confidence: 0 })).regression.probability;
    expect(uncovered).toBeGreaterThan(wellCovered);
  });
});

describe('formatSimulation', () => {
  it('renders the verdict, regression, drift and cycle', () => {
    const out = formatSimulation(
      simulateExecution(input({ inCycle: true, cycle: ['src/a', 'src/b'], dependentModules: ['src/api'], impactedFiles: ['src/api/a.ts'], dependents: 1 })),
    );
    expect(out).toMatch(/simulate: src\/x\.ts/);
    expect(out).toMatch(/REVIEW/);
    expect(out).toMatch(/regression probability/);
    expect(out).toMatch(/API-contract drift: src\/api/);
    expect(out).toMatch(/dependency cycle: src\/a → src\/b/);
  });
});
