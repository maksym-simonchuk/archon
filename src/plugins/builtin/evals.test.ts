import { describe, expect, it } from 'vitest';
import type { ArchonEvent } from '../../services/event-bus';
import { evalsRecorder, runEval, summariseEvals } from './evals';

const events: ArchonEvent[] = [
  { kind: 'turn.start', runId: 'r', at: 1, goal: 'x' },
  { kind: 'tokens.usage', runId: 'r', at: 2, provider: 'p', modelId: 'm', usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.05 } },
  { kind: 'verdict', runId: 'r', at: 3, ok: true, summary: 'green' },
];

describe('evals runner', () => {
  it('reports ok when verdict + cost expectations match', () => {
    const r = runEval({ name: 'happy', events, expect: { verdict: 'pass', maxCostUsd: 0.1 } });
    expect(r.ok).toBe(true);
  });

  it('flags mismatched verdict', () => {
    const r = runEval({ name: 'mismatch', events, expect: { verdict: 'fail' } });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('verdict');
  });

  it('summarises pass/fail counts and pass rate', () => {
    const s = summariseEvals([
      runEval({ name: 'a', events, expect: { verdict: 'pass' } }),
      runEval({ name: 'b', events, expect: { verdict: 'fail' } }),
    ]);
    expect(s).toEqual({ passed: 1, failed: 1, total: 2, passRate: 0.5 });
  });

  it('evalsRecorder accumulates then drains events', () => {
    const r = evalsRecorder();
    r.onEvent(events[0] as ArchonEvent);
    r.onEvent(events[1] as ArchonEvent);
    expect(r.take().length).toBe(2);
    expect(r.take().length).toBe(0);
  });
});
