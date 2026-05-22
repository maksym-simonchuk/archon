/**
 * Executable-skill runtime (M19). Turns a skill from a passive Markdown playbook
 * into a named, multi-phase workflow that runs in a fixed, gated order:
 *
 *   analyze → simulate → validate → execute → rollback
 *
 * Each phase is an injected closure; the app layer (which holds the fs/loop
 * authority) builds them from the existing primitives — risk/improve analysis,
 * the M20 execution simulation, the M14/M19 pre-apply gates, and the cognition
 * loop's worktree transaction. This module only *sequences* them, so it stays
 * plane-pure (it imports no fs / child_process / network — the effecting
 * isolation invariant): it composes behaviour, it never performs effects.
 *
 * The pipeline short-circuits the moment a gate refuses (`blocked`) or a
 * precondition fails (`failed`): nothing downstream runs. A pre-`execute` halt
 * never opened a worktree, so there is nothing to undo. If `execute` itself
 * fails, the loop's transaction has already discarded the worktree (ADR-0004) —
 * the runtime records that as a synthetic `rollback` outcome so the trace ends
 * "rolled back, working tree untouched", never a partial apply.
 */

export type SkillPhase = 'analyze' | 'simulate' | 'validate' | 'execute' | 'rollback';

/** `rollback` is synthesised by the runtime, never declared by a skill. */
export type DeclaredPhase = Exclude<SkillPhase, 'rollback'>;

/**
 * - `ok`      — the phase ran and the pipeline may continue.
 * - `blocked` — a gate refused (e.g. simulation predicts harm, a `review`
 *               verdict without `--force`); halts before any downstream phase.
 * - `failed`  — a precondition could not be met, or `execute`'s verify failed.
 * - `skipped` — the phase had nothing to do; non-halting.
 */
export type PhaseStatus = 'ok' | 'blocked' | 'failed' | 'skipped';

export interface PhaseOutcome {
  phase: SkillPhase;
  status: PhaseStatus;
  detail: string;
}

/** One declared phase of a skill; `run` receives the outcomes recorded so far. */
export interface PhaseStep {
  phase: DeclaredPhase;
  run: (prior: readonly PhaseOutcome[]) => Promise<{ status: PhaseStatus; detail: string }>;
}

export interface ExecutableSkill {
  name: string;
  description: string;
  /** Ordered phases (a subset of analyze → simulate → validate → execute). */
  steps: PhaseStep[];
}

export interface SkillRun {
  skill: string;
  outcomes: PhaseOutcome[];
  /** True only when an `execute` phase ran and its work merged. */
  applied: boolean;
  /** The phase that stopped the pipeline (`blocked`/`failed`), if any. */
  haltedAt?: SkillPhase;
}

/**
 * Run a skill's phases in declared order, applying the gating semantics above.
 * Returns the full outcome trace plus whether the change was applied. Pure
 * orchestration — every effect lives behind the injected `run` closures.
 */
export async function runSkill(skill: ExecutableSkill): Promise<SkillRun> {
  const outcomes: PhaseOutcome[] = [];
  for (const step of skill.steps) {
    const { status, detail } = await step.run(outcomes);
    outcomes.push({ phase: step.phase, status, detail });

    if (step.phase === 'execute') {
      // `execute` is terminal: success means the loop merged; failure means the
      // transaction already discarded the worktree, which we surface explicitly.
      if (status === 'ok') return { skill: skill.name, outcomes, applied: true };
      outcomes.push({
        phase: 'rollback',
        status: 'ok',
        detail: 'verify failed — worktree discarded, working tree untouched',
      });
      return { skill: skill.name, outcomes, applied: false, haltedAt: 'execute' };
    }

    // A pre-execute gate refusal or precondition failure stops the pipeline.
    // Nothing was applied, so no rollback is needed.
    if (status === 'blocked' || status === 'failed') {
      return { skill: skill.name, outcomes, applied: false, haltedAt: step.phase };
    }
  }
  // No `execute` phase declared (a read-only skill, e.g. architecture-review).
  return { skill: skill.name, outcomes, applied: false };
}

const GLYPH: Record<PhaseStatus, string> = { ok: '✓', blocked: '⛔', failed: '✗', skipped: '·' };

/** Render a skill run as an aligned, human-readable phase trace. */
export function formatSkillRun(run: SkillRun): string {
  const width = Math.max(...run.outcomes.map((o) => o.phase.length), 'analyze'.length);
  const rows = run.outcomes.map(
    (o) => `  ${GLYPH[o.status]} ${o.phase.padEnd(width)}  ${o.detail}`,
  );
  const verdict = run.applied
    ? 'applied — change merged'
    : run.haltedAt
      ? `not applied — halted at ${run.haltedAt}`
      : 'not applied';
  return [`skill: ${run.skill}`, ...rows, `  → ${verdict}`].join('\n');
}
