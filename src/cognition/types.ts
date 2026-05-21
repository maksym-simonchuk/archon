import type { Plan, Task } from '../core/types';

/**
 * A concrete, reversible mutation a plan step performs. v0 supports file writes
 * only; the union is the seam where future effect kinds (delete, exec) plug in.
 */
export type StepAction = { kind: 'write'; target: string; content: string };

/** A command the Verifier runs (argv, no shell) to judge a task's work. */
export interface VerifierCheck {
  name: string;
  argv: string[];
}

/**
 * A plan plus the concrete work behind it. The public `Plan` (steps with intent
 * + requested capability) is what `archon plan` prints and what gets pre-approved;
 * `actions` is what the Executor performs under the broker, keyed by step id;
 * `checks` is how the Verifier decides pass/fail. The planner — not the loop —
 * owns the definition of "done", so a strategy can scope verification to exactly
 * what it changed.
 */
export interface CognitivePlan {
  plan: Plan;
  actions: Record<string, StepAction>;
  checks: VerifierCheck[];
}

/** Turns a goal + assembled context into an executable, verifiable plan. */
export interface PlanStrategy {
  propose(task: Task, context: string): Promise<CognitivePlan>;
}
