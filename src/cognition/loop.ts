import type { JournalKind, StepResult, Task, Verdict } from '../core/types';
import type { Transaction } from '../effecting/transaction';
import type { TaskJournal } from '../services/task-journal';
import type { Executor } from './executor';
import type { Planner } from './planner';
import type { Reflector } from './reflector';
import type { Verifier } from './verifier';

/** Collaborators; the worktree-scoped ones are built once the transaction opens. */
export interface CognitionLoopDeps {
  planner: Planner;
  transaction: Transaction;
  reflector: Reflector;
  /** Durable, append-only record of the run (plan / step / verdict). */
  journal: TaskJournal;
  /** Build an Executor whose broker is rooted at the (now-known) worktree. */
  executorFor: (worktree: string, taskId: string) => Executor;
  /** Build a Verifier whose broker is rooted at the worktree. */
  verifierFor: (worktree: string) => Verifier;
}

const DISCARDED: Verdict = { passed: false, checks: [] };

/**
 * The load-bearing primitive: plan → act → verify → reflect, one smallest
 * reversible increment at a time, all inside a git-worktree transaction. A failed
 * step short-circuits and discards (the main tree is never touched); a clean run
 * verifies and, on a passing verdict, merges. Reflection records the outcome to
 * episodic memory either way. See ADR-0002 / ADR-0004.
 */
export class CognitionLoop {
  constructor(private readonly deps: CognitionLoopDeps) {}

  async run(task: Task, context = ''): Promise<StepResult[]> {
    const { planner, transaction, reflector, journal, executorFor, verifierFor } = this.deps;
    const note = (kind: JournalKind, payload: unknown): void => {
      journal.append({ taskId: task.id, ts: new Date().toISOString(), kind, payload });
    };

    const cog = await planner.plan(task, context);
    note('plan', { rationale: cog.plan.rationale, steps: cog.plan.steps.map((s) => s.intent) });

    const begun = await transaction.begin(task.id);
    if (!begun.ok) throw new Error(`[archon] cannot begin transaction: ${begun.error.message}`);
    const { worktree } = begun.value;
    const executor = executorFor(worktree, task.id);

    const results: StepResult[] = [];
    for (const step of cog.plan.steps) {
      const action = cog.actions[step.id];
      if (!action) {
        results.push({ stepId: step.id, verdict: { passed: false, checks: [{ name: 'plan', passed: false, output: 'no action for step' }] } });
        break;
      }
      const result = await executor.run(step, action);
      results.push(result);
      note('step', { stepId: result.stepId, passed: result.verdict.passed, files: result.diff?.files ?? [] });
      if (!result.verdict.passed) break;

      const committed = await transaction.commitStep(step.intent);
      if (!committed.ok) {
        results.push({ stepId: step.id, verdict: { passed: false, checks: [{ name: 'commit', passed: false, output: committed.error.message }] } });
        break;
      }
    }

    // Only verify if every step landed cleanly; otherwise the run is already a
    // discard. The Verifier runs inside the worktree, never the main tree.
    const stepsClean = results.every((r) => r.verdict.passed);
    const verdict = stepsClean ? await verifierFor(worktree).verify(worktree, cog.checks) : DISCARDED;
    if (stepsClean) results.push({ stepId: `${task.id}-verify`, verdict });
    note('verdict', { passed: verdict.passed, checks: verdict.checks });

    await transaction.finalize(verdict);
    await reflector.reflect(task, results);
    return results;
  }
}
