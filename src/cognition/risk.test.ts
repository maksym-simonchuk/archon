import { describe, expect, it } from 'vitest';
import type { ModuleNode } from '../sensing/boundaries';
import { classifyRegion, formatRisk, scoreRisk } from './risk';

const mod = (over: Partial<ModuleNode> = {}): ModuleNode => ({
  name: 'src/x',
  files: 3,
  fanIn: 0,
  fanOut: 0,
  instability: 0.5,
  role: 'balanced',
  ...over,
});

describe('scoreRisk', () => {
  it('rates an isolated, well-covered, low-coupling file as low', () => {
    const r = scoreRisk({ file: 'src/x/a.ts', module: mod(), blastRadius: 0, confidence: 1 });
    expect(r.level).toBe('low');
    expect(r.rationale).toContain('isolated, well-covered, low coupling');
  });

  it('escalates a load-bearing, untested file to critical', () => {
    const r = scoreRisk({
      file: 'src/core/c.ts',
      module: mod({ name: 'src/core', fanIn: 9, role: 'core' }),
      blastRadius: 30,
      confidence: 0.1,
    });
    expect(r.level).toBe('critical'); // large blast +2, high crit +2, low conf +2
    expect(r.region).toBe('stable');
    expect(r.rationale.some((x) => x.includes('blast radius'))).toBe(true);
  });

  it('treats a sensitive zone as never-modify → critical regardless of metrics', () => {
    const r = scoreRisk({ file: 'src/auth/login.ts', module: mod(), blastRadius: 0, confidence: 1 });
    expect(r.neverModify).toBe(true);
    expect(r.level).toBe('critical');
  });

  it('lands in the middle for a moderately-coupled, partially-tested file', () => {
    const r = scoreRisk({
      file: 'src/svc/s.ts',
      module: mod({ fanIn: 3 }),
      blastRadius: 6,
      confidence: 0.5,
    });
    expect(['medium', 'high']).toContain(r.level);
  });
});

describe('classifyRegion', () => {
  it('maps role to region', () => {
    expect(classifyRegion(mod({ role: 'core' }))).toBe('stable');
    expect(classifyRegion(mod({ role: 'isolated' }))).toBe('experimental');
    expect(classifyRegion(mod({ role: 'unstable' }))).toBe('evolving');
    expect(classifyRegion(undefined)).toBe('experimental');
  });
});

describe('formatRisk', () => {
  it('renders the level, module, metrics, and rationale', () => {
    const out = formatRisk(scoreRisk({ file: 'src/core/c.ts', module: mod({ name: 'src/core', fanIn: 9, role: 'core' }), blastRadius: 30, confidence: 0.1 }));
    expect(out).toContain('CRITICAL');
    expect(out).toContain('module src/core · region stable');
    expect(out).toContain('why:');
  });
});
