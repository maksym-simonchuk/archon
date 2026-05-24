/**
 * Council planner (M34). N planners propose in parallel; a synthesiser merges
 * or selects. Gated on Risk ≥ high or explicit `/council` opt-in because it is
 * 3–5× cost. Each planner returns its own OpenSpecChange; the synth picks the
 * best by composite score or merges compatible deltas.
 */

import type { OpenSpecChange } from './openspec/types';

export interface CouncilProposal {
  /** Planner identity (model id / provider / agent name). */
  planner: string;
  change: OpenSpecChange;
  /** Self-reported confidence 0..1 (planners may overstate; synth re-weighs). */
  confidence: number;
  /** Provider cost incurred to produce this proposal. */
  costUsd: number;
}

export interface CouncilOutcome {
  /** Proposal selected as the round winner. */
  winner: CouncilProposal;
  /** Sum of every planner's spend (for cost accounting). */
  totalCostUsd: number;
  /** Why the winner won — single line. */
  rationale: string;
  /** Number of distinct planners that voted for the winner's id. */
  agreement: number;
}

export interface CouncilOptions {
  /** Weight self-confidence in the score (default 0.25). */
  confidenceWeight?: number;
  /** Weight agreement-among-planners in the score (default 0.5). */
  agreementWeight?: number;
  /** Weight inverse-cost in the score (default 0.25). */
  costWeight?: number;
}

const norm = (xs: number[]): number[] => {
  if (xs.length === 0) return xs;
  const max = Math.max(...xs);
  return max > 0 ? xs.map((x) => x / max) : xs.map(() => 0);
};

/** Synthesise N proposals into one selected change. Pure — no I/O. */
export function synthesise(proposals: CouncilProposal[], opts: CouncilOptions = {}): CouncilOutcome {
  if (proposals.length === 0) throw new Error('council: at least one proposal required');
  const wc = opts.confidenceWeight ?? 0.25;
  const wa = opts.agreementWeight ?? 0.5;
  const wk = opts.costWeight ?? 0.25;

  // Count agreement by change.id — proposers converging on the same id win.
  const idCounts = new Map<string, number>();
  for (const p of proposals) idCounts.set(p.change.id, (idCounts.get(p.change.id) ?? 0) + 1);
  const maxAgreement = Math.max(...idCounts.values());

  // Score = wc·confidence + wa·(agreement/N) + wk·(1 - cost/maxCost).
  const costs = proposals.map((p) => p.costUsd);
  const invCost = norm(costs.map((c) => Math.max(0, Math.max(...costs) - c)));

  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i] as CouncilProposal;
    const agreement = (idCounts.get(p.change.id) ?? 1) / proposals.length;
    const score = wc * p.confidence + wa * agreement + wk * (invCost[i] as number);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  const winner = proposals[bestIdx] as CouncilProposal;
  const totalCostUsd = proposals.reduce((s, p) => s + p.costUsd, 0);
  const rationale = `score=${bestScore.toFixed(3)} · agreement=${idCounts.get(winner.change.id)}/${proposals.length} · cost=$${winner.costUsd.toFixed(3)}`;
  return { winner, totalCostUsd, rationale, agreement: maxAgreement };
}

/** Run multiple planners in parallel and synthesise. Each planner is a thunk. */
export async function runCouncil(
  planners: Array<{ name: string; plan: () => Promise<{ change: OpenSpecChange; confidence: number; costUsd: number }> }>,
  opts: CouncilOptions = {},
): Promise<CouncilOutcome> {
  const settled = await Promise.allSettled(planners.map((p) => p.plan()));
  const proposals: CouncilProposal[] = [];
  for (let i = 0; i < planners.length; i++) {
    const r = settled[i];
    const p = planners[i] as { name: string };
    if (!r || r.status !== 'fulfilled') continue;
    proposals.push({ planner: p.name, ...r.value });
  }
  if (proposals.length === 0) throw new Error('council: every planner failed');
  return synthesise(proposals, opts);
}
