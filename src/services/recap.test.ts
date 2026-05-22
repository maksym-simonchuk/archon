import { describe, expect, it } from 'vitest';
import type { JournalEntry } from '../core/types';
import type { HealthSnapshot } from '../sensing/store';
import { formatRecap, recap } from './recap';

let seq = 0;
const e = (taskId: string, kind: JournalEntry['kind'], payload: unknown, ts: string): JournalEntry => ({
  seq: seq++,
  taskId,
  ts,
  kind,
  payload,
});

const health = (score: number, high = 0, medium = 0, low = 0): HealthSnapshot => ({
  ts: '2026-05-23T00:00:00Z',
  inputHash: 'h',
  score,
  high,
  medium,
  low,
});

describe('recap', () => {
  it('rolls journal entries up per run with outcome, steps, and cost', () => {
    const entries = [
      e('t1', 'plan', { rationale: 'add a widget', steps: ['s1', 's2'] }, '2026-05-23T10:00:00Z'),
      e('t1', 'verdict', { passed: true, checks: [] }, '2026-05-23T10:01:00Z'),
      e('t1', 'decision', { merged: true, outcome: 'merged' }, '2026-05-23T10:02:00Z'),
      e('t1', 'cost', { usd: 0.0123 }, '2026-05-23T10:02:30Z'),
    ];
    const model = recap(entries, []);
    expect(model.totals).toEqual({ runs: 1, merged: 1, unmerged: 0, costUsd: 0.0123 });
    expect(model.runs[0]).toMatchObject({
      taskId: 't1',
      summary: 'add a widget',
      steps: 2,
      merged: true,
      outcome: 'merged',
      costUsd: 0.0123,
      at: '2026-05-23T10:00:00Z',
    });
  });

  it('orders runs newest-first and counts unmerged runs', () => {
    const entries = [
      e('old', 'plan', { rationale: 'first', steps: [] }, '2026-05-23T09:00:00Z'),
      e('old', 'decision', { merged: true, outcome: 'merged' }, '2026-05-23T09:01:00Z'),
      e('new', 'plan', { rationale: 'second', steps: ['x'] }, '2026-05-23T11:00:00Z'),
      e('new', 'decision', { merged: false, outcome: 'blocked by pre-apply hooks' }, '2026-05-23T11:01:00Z'),
    ];
    const model = recap(entries, []);
    expect(model.runs.map((r) => r.taskId)).toEqual(['new', 'old']);
    expect(model.totals).toMatchObject({ runs: 2, merged: 1, unmerged: 1 });
    expect(model.runs[0].outcome).toBe('blocked by pre-apply hooks');
  });

  it('marks a run with no decision entry as incomplete (e.g. a crash)', () => {
    const model = recap([e('t', 'plan', { rationale: 'crashed', steps: [] }, '2026-05-23T10:00:00Z')], []);
    expect(model.runs[0]).toMatchObject({ outcome: 'incomplete', merged: false });
  });

  it('reports the latest health score with a delta vs the previous snapshot', () => {
    const model = recap([], [health(70), health(82, 1, 2, 3)]);
    expect(model.health).toEqual({ score: 82, delta: 12, high: 1, medium: 2, low: 3 });
  });

  it('reports a null delta when only one health snapshot exists, and omits health when none', () => {
    expect(recap([], [health(50)]).health?.delta).toBeNull();
    expect(recap([], []).health).toBeUndefined();
  });
});

describe('formatRecap', () => {
  it('summarizes runs, totals, and the health trend arrow', () => {
    const entries = [
      e('t1', 'plan', { rationale: 'add a widget', steps: ['s1'] }, '2026-05-23T10:00:00Z'),
      e('t1', 'decision', { merged: true, outcome: 'merged' }, '2026-05-23T10:02:00Z'),
    ];
    const out = formatRecap(recap(entries, [health(70), health(65, 2, 0, 0)]));
    expect(out).toContain('1 run(s) — 1 merged, 0 unmerged');
    expect(out).toContain('add a widget');
    expect(out).toContain('▼ -5'); // health dropped 70 → 65
  });

  it('guides the user when nothing has been journaled', () => {
    expect(formatRecap(recap([], []))).toContain('no runs journaled yet');
  });
});
