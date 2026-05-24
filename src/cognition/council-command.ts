/**
 * Council command (M34). Cross-checks the configured planner against a
 * deterministic `ScaffoldStrategy` voter, runs every proposer in parallel,
 * and synthesises a winner. The substrate (`synthesise` in `./council.ts`)
 * stays pure — this module is the shell-shaped adapter that wires real
 * planners into it.
 *
 * Why two voters by default and not N: a true multi-provider fan-out is M34's
 * end-state, but it requires per-provider `ProviderPlanner`s and a fan-out
 * cost budget. The minimum useful cross-check is "the LLM agrees with a
 * deterministic shape" — that catches model hallucination on trivial scaffolds
 * for ~zero extra cost (the scaffolder is offline). When the offline planner
 * is the only one configured, the council still runs (single voter) and the
 * synthesiser picks the only proposal — the UX simply notes "no LLM planner".
 *
 * Pure side-effect: routes through `rt.planner()` and `rt.context(task)` only —
 * no direct fs/network. Spec emit is intentionally NOT performed here (that
 * lives in `cmdPlan`'s `emitOpenSpecChange`); /council is a planning-time
 * inspection, not a plan-commit.
 */

import type { Runtime } from '../runtime';
import { makeTask } from '../commands';
import type { CognitivePlan } from './types';
import type { CouncilProposal, CouncilOutcome } from './council';
import { synthesise } from './council';
import { changeFromPlanSummary } from './openspec/broker-spec-store';
import { Planner } from './planner';
import { ScaffoldStrategy } from './scaffold-strategy';

/**
 * Why `0.7` for LLM and `0.5` for scaffold: planner self-confidence isn't
 * actually reported by either strategy yet — when it is (M34 stretch), this
 * constant becomes the proposal's `confidence` field. Until then the synthesiser's
 * agreement + cost weights dominate. Keep the LLM nominally higher so two
 * proposals with the same OpenSpecChange id tie-break toward the LLM (it
 * exercised more context).
 */
const CONF_LLM = 0.7;
const CONF_SCAFFOLD = 0.5;

/** One planner's run — exposed so the shell can render the per-voter score. */
export interface CouncilVoter {
  /** Planner identity (matches `CouncilProposal.planner`). */
  name: string;
  /** The full plan as the strategy returned it (steps + checks). */
  plan: CognitivePlan;
  /** Provider cost delta this voter incurred (0 for the offline scaffolder). */
  costUsd: number;
}

/** Aggregate result returned to the shell (and tests). */
export interface CouncilReport {
  /** The synthesiser's pick + scoring rationale. */
  outcome: CouncilOutcome;
  /** Every voter that produced a proposal (failed voters drop out silently). */
  voters: CouncilVoter[];
  /** True iff the active runtime has an LLM-backed planner configured. */
  llmPlanning: boolean;
}

/**
 * Run a council vote for `goal`. The configured planner (LLM or scaffold) is
 * the *first* voter; an offline `ScaffoldStrategy` is the *second* voter (a
 * deterministic sanity check that runs in parallel). When `llmPlanning=false`
 * the two voters would propose identical shapes — so we run only the
 * scaffolder, and the council degrades to single-voter (still useful for
 * inspecting the deterministic plan).
 *
 * The function never throws on a single voter failure: an LLM provider error
 * leaves the scaffolder as the sole voter (and the failure is surfaced in
 * `voters.length < expected`). It throws only when EVERY voter fails — which
 * mirrors `runCouncil`'s contract in `./council.ts`.
 */
export async function runCouncilCommand(rt: Runtime, goal: string): Promise<CouncilReport> {
  const task = makeTask(goal, rt.config.profile);
  const ctx = await rt.context(task);

  // Snapshot router spend so each voter's costUsd is the delta it caused.
  const spendBefore = rt.router.spent;

  // Voter A: the configured planner (LLM when keys present, else scaffold).
  const voterA = rt.planner();
  // Voter B: always a fresh deterministic scaffolder — but only when it would
  // differ from voter A. Otherwise we'd be voting against an identical twin.
  const offlineCrossCheck = rt.llmPlanning ? new Planner(new ScaffoldStrategy()) : undefined;

  const results = await Promise.allSettled([
    voterA.plan(task, ctx),
    offlineCrossCheck ? offlineCrossCheck.plan(task, '') : Promise.resolve<CognitivePlan | undefined>(undefined),
  ]);

  const voters: CouncilVoter[] = [];
  const proposals: CouncilProposal[] = [];

  const aResult = results[0];
  if (aResult && aResult.status === 'fulfilled' && aResult.value) {
    const plan = aResult.value;
    const name = rt.llmPlanning ? 'llm' : 'scaffold';
    const costUsd = Math.max(0, rt.router.spent - spendBefore);
    voters.push({ name, plan, costUsd });
    proposals.push({
      planner: name,
      change: changeFromPlanSummary({
        id: plan.plan.taskId.replace(/[^a-z0-9-]+/gi, '-').toLowerCase(),
        goal: plan.plan.rationale,
        why: plan.plan.rationale,
        tasks: plan.plan.steps.map((s) => s.intent).filter((t) => t.length > 0),
      }).change,
      confidence: rt.llmPlanning ? CONF_LLM : CONF_SCAFFOLD,
      costUsd,
    });
  }

  const bResult = results[1];
  if (bResult && bResult.status === 'fulfilled' && bResult.value) {
    const plan = bResult.value;
    voters.push({ name: 'scaffold-cross-check', plan, costUsd: 0 });
    proposals.push({
      planner: 'scaffold-cross-check',
      change: changeFromPlanSummary({
        id: plan.plan.taskId.replace(/[^a-z0-9-]+/gi, '-').toLowerCase(),
        goal: plan.plan.rationale,
        why: plan.plan.rationale,
        tasks: plan.plan.steps.map((s) => s.intent).filter((t) => t.length > 0),
      }).change,
      confidence: CONF_SCAFFOLD,
      costUsd: 0,
    });
  }

  if (proposals.length === 0) {
    const reasons = results
      .map((r, i) => (r.status === 'rejected' ? `voter ${i}: ${String(r.reason)}` : null))
      .filter((s): s is string => s !== null);
    throw new Error(`council: every planner failed — ${reasons.join('; ')}`);
  }

  return {
    outcome: synthesise(proposals),
    voters,
    llmPlanning: rt.llmPlanning,
  };
}
