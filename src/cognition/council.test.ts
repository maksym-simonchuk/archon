import { describe, expect, it } from 'vitest';
import type { OpenSpecChange } from './openspec/types';
import { runCouncil, synthesise } from './council';

const change = (id: string): OpenSpecChange => ({
  id,
  proposal: { why: ['x'], what: ['y'], whyNow: [] },
  tasks: [{ done: false, text: 't' }],
  specs: [],
});

describe('council synthesise', () => {
  it('picks the proposal with the highest composite score', () => {
    const out = synthesise([
      { planner: 'a', change: change('add-feature'), confidence: 0.9, costUsd: 0.5 },
      { planner: 'b', change: change('add-feature'), confidence: 0.8, costUsd: 0.4 },
      { planner: 'c', change: change('different-feature'), confidence: 0.7, costUsd: 0.6 },
    ]);
    // Two planners agreed on `add-feature` — agreement weight pushes one of those.
    expect(out.winner.change.id).toBe('add-feature');
    expect(out.agreement).toBe(2);
    expect(out.totalCostUsd).toBeCloseTo(1.5, 5);
  });

  it('throws when no proposals are supplied', () => {
    expect(() => synthesise([])).toThrow();
  });
});

describe('council runCouncil', () => {
  it('runs planners in parallel and ignores failures', async () => {
    const out = await runCouncil([
      { name: 'a', plan: async () => ({ change: change('x'), confidence: 0.8, costUsd: 0.2 }) },
      { name: 'b', plan: async () => Promise.reject(new Error('rate limited')) },
      { name: 'c', plan: async () => ({ change: change('x'), confidence: 0.9, costUsd: 0.3 }) },
    ]);
    expect(out.winner.change.id).toBe('x');
    expect(out.agreement).toBe(2);
  });

  it('throws if every planner fails', async () => {
    await expect(
      runCouncil([
        { name: 'a', plan: async () => Promise.reject(new Error('down')) },
        { name: 'b', plan: async () => Promise.reject(new Error('down')) },
      ]),
    ).rejects.toThrow(/every planner failed/);
  });
});
