import { describe, expect, it } from 'vitest';
import type { Violation } from '../sensing/violations';
import { formatImprovements, proposeImprovements } from './improve';

const v = (over: Partial<Violation>): Violation => ({
  kind: 'missing-tests',
  severity: 'low',
  subject: 'src/x/a.ts',
  detail: '',
  impact: 1,
  ...over,
});

describe('proposeImprovements', () => {
  it('maps each violation kind to a conservative action', () => {
    const { proposals } = proposeImprovements({
      violations: [
        v({ kind: 'circular-dependency', subject: 'src/a ↔ src/b', impact: 9 }),
        v({ kind: 'god-module', subject: 'src/core', impact: 8 }),
        v({ kind: 'unstable-dependency', subject: 'src/a → src/b', impact: 4 }),
        v({ kind: 'missing-tests', subject: 'src/x/a.ts', impact: 1 }),
      ],
    });
    const byKind = Object.fromEntries(proposals.map((p) => [p.subject, p.action]));
    expect(byKind['src/a ↔ src/b']).toBe('break-cycle');
    expect(byKind['src/core']).toBe('decompose');
    expect(byKind['src/a → src/b']).toBe('realign-dependency');
    expect(byKind['src/x/a.ts']).toBe('add-tests');
  });

  it('ranks by ROI (value / effort), highest first', () => {
    const { proposals } = proposeImprovements({
      violations: [
        v({ kind: 'god-module', subject: 'src/core', impact: 10 }), // 10/5 = 2
        v({ kind: 'unstable-dependency', subject: 'src/a → src/b', impact: 6 }), // 6/2 = 3
      ],
    });
    expect(proposals[0].subject).toBe('src/a → src/b');
    expect(proposals[0].roi).toBe(3);
  });

  it('skips a violation whose subject is preserved', () => {
    const report = proposeImprovements({
      violations: [v({ kind: 'god-module', subject: 'src/auth', impact: 8 })],
      protectedSubjects: new Set(['src/auth']),
    });
    expect(report.proposals).toHaveLength(0);
    expect(report.skipped[0].subject).toBe('src/auth');
  });

  it('skips a cycle when either module in it is preserved', () => {
    const report = proposeImprovements({
      violations: [v({ kind: 'circular-dependency', subject: 'src/a ↔ src/payments', impact: 9 })],
      protectedSubjects: new Set(['src/payments']),
    });
    expect(report.proposals).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
  });
});

describe('formatImprovements', () => {
  it('reports clean when there is nothing to do', () => {
    expect(formatImprovements(proposeImprovements({ violations: [] }))).toContain('architecture is clean');
  });

  it('lists ranked proposals and a preserved section', () => {
    const out = formatImprovements(
      proposeImprovements({
        violations: [
          v({ kind: 'god-module', subject: 'src/core', impact: 8 }),
          v({ kind: 'god-module', subject: 'src/auth', impact: 8 }),
        ],
        protectedSubjects: new Set(['src/auth']),
      }),
    );
    expect(out).toContain('conservative improvements');
    expect(out).toContain('preserved (not auto-proposed)');
  });
});
