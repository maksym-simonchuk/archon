import type { Task } from '../core/types';
import type { CognitivePlan, PlanStrategy } from './types';

/**
 * Decomposes a goal into a plan of smallest reversible steps — plan before act.
 * The intelligence is pluggable: a `PlanStrategy` (the deterministic scaffolder,
 * or an LLM-backed planner over the ProviderRouter) turns the goal + a pre-
 * assembled, budgeted context string into an executable, verifiable plan. The
 * Planner only delegates, so `archon plan` (dry-run) and `archon run` share one
 * path and a plan can be inspected before any side effect occurs.
 */
export class Planner {
  constructor(private readonly strategy: PlanStrategy) {}

  async plan(task: Task, context = ''): Promise<CognitivePlan> {
    return this.strategy.propose(task, context);
  }
}
