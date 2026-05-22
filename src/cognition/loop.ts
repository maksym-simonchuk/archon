import type { JournalKind, StepResult, Task, Verdict } from '../core/types';
import type { PreHookFinding } from '../effecting/hooks';
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
  /** Durable, append-only record of the run (plan / step / diff / verdict / decision / cost). */
  journal: TaskJournal;
  /** Build an Executor whose broker is rooted at the (now-known) worktree. */
  executorFor: (worktree: string, taskId: string) => Executor;
  /** Build a Verifier whose broker is rooted at the worktree. */
  verifierFor: (worktree: string) => Verifier;
  /**
   * Run loaded `verifier`-kind plugins over the run's changed files, returning a
   * verdict each. Folded into the built-in verdict with AND (a failing plugin
   * discards the run), so plugins can only make verification stricter. Omitted ⇒
   * built-in checks only.
   */
  verifierPlugins?: (files: string[]) => Promise<Verdict[]>;
  /**
   * Static pre-apply gate (M19): given the plan's planned writes (target + the
   * content it would write), return the hook findings. A `block` finding aborts
   * the run BEFORE any worktree is opened — nothing is written. Pure structural
   * check (never-modify zones, import cycles, boundary leaks); omitted ⇒ no gate
   * (the broker still gates every individual write). It can only stop a run, never
   * authorise one — tighten, never widen.
   */
  preApply?: (writes: { target: string; content: string }[]) => Promise<PreHookFinding[]>;
  /** Provider spend (USD) to record as the run's `cost` entry; omitted ⇒ no cost entry. */
  cost?: () => number;
}

const DISCARDED: Verdict = { passed: false, checks: [] };

/** Fold extra verdicts into a base with AND: every part must pass; checks accumulate. */
const mergeVerdicts = (base: Verdict, extra: Verdict[]): Verdict => ({
  passed: base.passed && extra.every((v) => v.passed),
  checks: [...base.checks, ...extra.flatMap((v) => v.checks)],
});

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
    const { planner, transaction, reflector, journal, executorFor, verifierFor, verifierPlugins, preApply, cost } = this.deps;
    const note = (kind: JournalKind, payload: unknown): void => {
      journal.append({ taskId: task.id, ts: new Date().toISOString(), kind, payload });
    };

    const cog = await planner.plan(task, context);
    note('plan', { rationale: cog.plan.rationale, steps: cog.plan.steps.map((s) => s.intent) });

    // Pre-apply gate (M19): a `block` finding (write into a never-modify zone, or
    // an import that would close a module cycle) stops the run before any worktree
    // exists — the safest possible point, since nothing has been written. The gate
    // can only refuse; it never grants authority the broker wouldn't.
    if (preApply) {
      const writes = Object.values(cog.actions)
        .filter((a) => a.kind === 'write')
        .map((a) => ({ target: a.target, content: a.content }));
      const blocks = (await preApply(writes)).filter((f) => f.severity === 'block');
      if (blocks.length > 0) {
        const verdict: Verdict = {
          passed: false,
          checks: blocks.map((b) => ({ name: `prehook:${b.hook}`, passed: false, output: `${b.subject} — ${b.detail}` })),
        };
        note('verdict', { passed: false, checks: verdict.checks });
        note('decision', { merged: false, outcome: 'blocked by pre-apply hooks (no worktree opened)' });
        const results: StepResult[] = [{ stepId: `${task.id}-prehook`, verdict }];
        await reflector.reflect(task, results);
        return results;
      }
    }

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
      note('step', { stepId: result.stepId, passed: result.verdict.passed });
      if (result.diff) {
        note('diff', {
          stepId: result.stepId,
          files: result.diff.files,
          added: result.diff.added,
          removed: result.diff.removed,
        });
      }
      if (!result.verdict.passed) break;

      const committed = await transaction.commitStep(step.intent);
      if (!committed.ok) {
        results.push({ stepId: step.id, verdict: { passed: false, checks: [{ name: 'commit', passed: false, output: committed.error.message }] } });
        break;
      }
    }

    // Only verify if every step landed cleanly; otherwise the run is already a
    // discard. The Verifier runs inside the worktree, never the main tree. When
    // verifier plugins are wired, fold their verdicts in with AND (over the
    // run's changed files) — they can tighten the result but never rescue a
    // failing built-in verdict into a merge.
    const stepsClean = results.every((r) => r.verdict.passed);
    let verdict = DISCARDED;
    if (stepsClean) {
      verdict = await verifierFor(worktree).verify(worktree, cog.checks);
      if (verifierPlugins) {
        const changed = [...new Set(results.flatMap((r) => r.diff?.files ?? []))];
        verdict = mergeVerdicts(verdict, await verifierPlugins(changed));
      }
      results.push({ stepId: `${task.id}-verify`, verdict });
    }
    note('verdict', { passed: verdict.passed, checks: verdict.checks });

    const finalized = await transaction.finalize(verdict);
    note('decision', {
      merged: finalized.ok && finalized.value === 'merged',
      outcome: finalized.ok ? finalized.value : finalized.error.message,
    });
    if (cost) note('cost', { usd: cost() });
    await reflector.reflect(task, results);
    return results;
  }
}
