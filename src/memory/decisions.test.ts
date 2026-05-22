import { describe, expect, it } from 'vitest';
import type { BoundaryModel, ModuleNode } from '../sensing/boundaries';
import {
  assessSignificance,
  decisionContent,
  formatDecisions,
  matchesQuery,
  parseAdr,
  proposeAdr,
} from './decisions';

const ADR = `# 0003 — Single Capability Broker

- Status: accepted
- Date: 2026-05-21
- Deciders: Archon core

## Context

Ambient authority lets any code reach the filesystem directly.

## Decision

Route every side effect through one Capability Broker; no ambient authority.

## Consequences

- Positive: one audited choke point.
- Cost: a hop on every effect.

## Alternatives considered

- Per-module guards — rejected because authority would scatter.
`;

describe('parseAdr', () => {
  it('extracts id, title, status, date, and the section bodies', () => {
    const d = parseAdr(ADR, 'docs/adr/0003-single-capability-broker.md');
    expect(d).toMatchObject({ id: '0003', title: 'Single Capability Broker', status: 'accepted', date: '2026-05-21' });
    expect(d.decision).toContain('one Capability Broker');
    expect(d.alternatives).toContain('Per-module guards');
    expect(d.consequences).toContain('one audited choke point');
  });

  it('falls back to the filename for the id and tolerates a missing section', () => {
    const d = parseAdr('# 0007 — Router\n\n- Status: proposed\n', '0007-router.md');
    expect(d).toMatchObject({ id: '0007', status: 'proposed' });
    expect(d.context).toBe('');
    expect(d.alternatives).toBe('');
  });

  it('marks an unrecognized status as unknown', () => {
    expect(parseAdr('# 1 — X\n\n- Status: draftish\n', 'x.md').status).toBe('unknown');
  });
});

describe('matchesQuery / decisionContent', () => {
  const d = parseAdr(ADR, 'docs/adr/0003.md');

  it('matches case-insensitively across title and bodies', () => {
    expect(matchesQuery(d, 'broker')).toBe(true);
    expect(matchesQuery(d, 'AMBIENT')).toBe(true); // body, case-insensitive
    expect(matchesQuery(d, 'kubernetes')).toBe(false);
  });

  it('compacts the decision into why / tradeoffs / rejected lines', () => {
    const c = decisionContent(d);
    expect(c).toContain('ADR-0003 [accepted] Single Capability Broker');
    expect(c).toContain('why: Route every side effect');
    expect(c).toContain('rejected: - Per-module guards');
  });
});

describe('formatDecisions', () => {
  const d = parseAdr(ADR, 'docs/adr/0003.md');
  it('lists recorded decisions', () => {
    expect(formatDecisions([d])).toContain('ADR-0003 [accepted] Single Capability Broker');
  });
  it('reports an empty query result', () => {
    expect(formatDecisions([], 'xyz')).toContain('no ADR matches "xyz"');
  });
});

const mod = (over: Partial<ModuleNode> & { name: string }): ModuleNode => ({
  files: 3,
  fanIn: 0,
  fanOut: 0,
  instability: 0.5,
  role: 'balanced',
  ...over,
});
const model = (modules: ModuleNode[], godModules: BoundaryModel['godModules'] = []): BoundaryModel => ({
  modules,
  couplingHotspots: [],
  godModules,
  cycles: [],
});

describe('assessSignificance', () => {
  it('flags a change that reaches into a core module', () => {
    const m = model([mod({ name: 'src/core', fanIn: 8, fanOut: 1, role: 'core' })]);
    const sig = assessSignificance({ hash: 'a', files: ['src/core/x.ts'] }, m);
    expect(sig.significant).toBe(true);
    expect(sig.reason).toContain('load-bearing');
    expect(sig.touchedModules[0].name).toBe('src/core');
  });

  it('flags a broad change by file count', () => {
    const m = model([mod({ name: 'src/x' })]);
    const files = Array.from({ length: 5 }, (_, i) => `src/x/f${i}.ts`);
    expect(assessSignificance({ hash: 'a', files }, m).significant).toBe(true);
  });

  it('does not flag a small, low-criticality change', () => {
    const m = model([mod({ name: 'src/x', fanIn: 0, fanOut: 1, role: 'unstable' })]);
    const sig = assessSignificance({ hash: 'a', files: ['src/x/one.ts'] }, m);
    expect(sig.significant).toBe(false);
    expect(sig.reason).toContain('localized');
  });
});

describe('proposeAdr', () => {
  it('drafts a proposed-status ADR with the next id and the auto-detected context', () => {
    const m = model([mod({ name: 'src/core', fanIn: 8, fanOut: 1, role: 'core' })]);
    const commit = { hash: 'abcdef1234', files: ['src/core/x.ts'] };
    const draft = proposeAdr('0013', commit, assessSignificance(commit, m), '2026-05-22');
    expect(draft).toContain('# 0013 —');
    expect(draft).toContain('- Status: proposed');
    expect(draft).toContain('commit `abcdef12`');
    expect(draft).toContain('`src/core`');
    expect(draft).toContain('## Alternatives considered'); // template prompts preserved
  });
});
