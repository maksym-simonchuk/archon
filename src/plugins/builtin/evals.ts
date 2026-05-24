/**
 * `archon-evals` plugin (M36). Replay-driven evaluation suite — each eval is a
 * fixture (a recorded session) plus an expected verdict. The runner replays
 * the fixture's bus events into a headless evaluator and reports pass/fail.
 *
 * Pure substrate — no FS, no network. The host wires fixture loading
 * (broker-mediated read) and report rendering.
 */

import type { ArchonEvent } from '../../services/event-bus';
import type { EventListenerPlugin } from '../abi-v1';

export interface EvalFixture {
  name: string;
  /** Recorded event stream. */
  events: ArchonEvent[];
  /** What we expect at the end. */
  expect: { verdict: 'pass' | 'fail'; minCostUsd?: number; maxCostUsd?: number; tokensOver?: number };
}

export interface EvalReport {
  name: string;
  ok: boolean;
  reasons: string[];
  observed: { verdict?: 'pass' | 'fail'; totalCostUsd: number; totalTokens: number };
}

export function runEval(fixture: EvalFixture): EvalReport {
  const reasons: string[] = [];
  let verdict: 'pass' | 'fail' | undefined;
  let totalCostUsd = 0;
  let totalTokens = 0;
  for (const e of fixture.events) {
    if (e.kind === 'verdict') verdict = e.ok ? 'pass' : 'fail';
    else if (e.kind === 'tokens.usage') {
      totalCostUsd += e.usage.costUsd;
      totalTokens += e.usage.inputTokens + e.usage.outputTokens;
    }
  }
  if (fixture.expect.verdict !== verdict) reasons.push(`verdict: expected ${fixture.expect.verdict}, got ${verdict ?? 'none'}`);
  if (fixture.expect.minCostUsd !== undefined && totalCostUsd < fixture.expect.minCostUsd)
    reasons.push(`cost: ${totalCostUsd.toFixed(4)} < ${fixture.expect.minCostUsd}`);
  if (fixture.expect.maxCostUsd !== undefined && totalCostUsd > fixture.expect.maxCostUsd)
    reasons.push(`cost: ${totalCostUsd.toFixed(4)} > ${fixture.expect.maxCostUsd}`);
  if (fixture.expect.tokensOver !== undefined && totalTokens <= fixture.expect.tokensOver)
    reasons.push(`tokens: ${totalTokens} <= ${fixture.expect.tokensOver}`);
  return {
    name: fixture.name,
    ok: reasons.length === 0,
    reasons,
    observed: { ...(verdict ? { verdict } : {}), totalCostUsd, totalTokens },
  };
}

export function summariseEvals(reports: EvalReport[]): { passed: number; failed: number; total: number; passRate: number } {
  const passed = reports.filter((r) => r.ok).length;
  return { passed, failed: reports.length - passed, total: reports.length, passRate: reports.length ? passed / reports.length : 0 };
}

/** Bundled plugin wrapper — observes bus events and accumulates a session fixture. */
export const evalsRecorder = (): EventListenerPlugin & { take: () => ArchonEvent[] } => {
  const events: ArchonEvent[] = [];
  return {
    kind: 'event-listener',
    manifest: { name: 'archon-evals', version: '0.1.0', kind: 'verifier', capabilities: [] },
    onEvent(e) {
      events.push(e);
    },
    take(): ArchonEvent[] {
      const out = events.slice();
      events.length = 0;
      return out;
    },
  };
};
