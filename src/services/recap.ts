import type { JournalEntry } from '../core/types';
import type { HealthSnapshot } from '../sensing/store';

/**
 * Recap (read-only observability): a digest of Archon's own recent activity,
 * reconstructed from the task journal — what was attempted, whether it merged or
 * was discarded, and what it cost — plus the latest architecture-health reading
 * and its trend. Where `status` lists raw journal entries newest-first and
 * `doctor` reports readiness, `recap` rolls the journal up *per run* so a glance
 * answers "what has Archon been doing, and is the codebase trending better or
 * worse?". Pure over already-loaded data; the command owns the I/O.
 */

/** One reconstructed task run. */
export interface RecapRun {
  taskId: string;
  /** Earliest journal timestamp for the task (when the run started). */
  at: string;
  /** The plan's rationale — the closest in-journal proxy for the run's goal. */
  summary: string;
  /** Number of planned steps. */
  steps: number;
  /** The decision outcome (e.g. `merged`, `discarded`, `blocked by pre-apply hooks`). */
  outcome: string;
  /** True only when the worktree was merged (a clean, applied run). */
  merged: boolean;
  /** Total provider spend recorded for the run. */
  costUsd: number;
}

export interface RecapModel {
  /** Reconstructed runs, newest first. */
  runs: RecapRun[];
  totals: { runs: number; merged: number; unmerged: number; costUsd: number };
  /** Latest health reading + delta vs the previous snapshot (null when first). */
  health?: { score: number; delta: number | null; high: number; medium: number; low: number };
  /** Number of journal entries scanned to build the recap. */
  scanned: number;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/**
 * Roll a flat journal stream up into per-run summaries + totals + the health
 * trend. Entries may arrive in any order (the command passes the newest window);
 * runs are grouped by `taskId` and returned newest-first by start time. A run
 * with no `decision` entry is reported `incomplete` (e.g. a crash mid-run).
 */
export function recap(entries: JournalEntry[], health: HealthSnapshot[]): RecapModel {
  const byTask = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    const list = byTask.get(e.taskId) ?? [];
    list.push(e);
    byTask.set(e.taskId, list);
  }

  const runs: RecapRun[] = [];
  for (const [taskId, group] of byTask) {
    const at = group.reduce((min, e) => (e.ts < min ? e.ts : min), group[0].ts);
    const plan = group.find((e) => e.kind === 'plan');
    const decision = group.find((e) => e.kind === 'decision');
    const planPayload = asRecord(plan?.payload);
    const decisionPayload = asRecord(decision?.payload);
    const steps = Array.isArray(planPayload.steps) ? planPayload.steps.length : 0;
    const costUsd = group
      .filter((e) => e.kind === 'cost')
      .reduce((sum, e) => sum + (typeof asRecord(e.payload).usd === 'number' ? (asRecord(e.payload).usd as number) : 0), 0);

    runs.push({
      taskId,
      at,
      summary: typeof planPayload.rationale === 'string' ? planPayload.rationale : '(no plan recorded)',
      steps,
      outcome: typeof decisionPayload.outcome === 'string' ? decisionPayload.outcome : 'incomplete',
      merged: decisionPayload.merged === true,
      costUsd,
    });
  }
  runs.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)); // newest first

  const merged = runs.filter((r) => r.merged).length;
  const totals = {
    runs: runs.length,
    merged,
    unmerged: runs.length - merged,
    costUsd: runs.reduce((sum, r) => sum + r.costUsd, 0),
  };

  // Health trend: latest snapshot + delta vs the one before it (history is oldest-first).
  let healthBlock: RecapModel['health'];
  if (health.length > 0) {
    const latest = health[health.length - 1];
    const prev = health.length > 1 ? health[health.length - 2] : undefined;
    healthBlock = {
      score: latest.score,
      delta: prev ? latest.score - prev.score : null,
      high: latest.high,
      medium: latest.medium,
      low: latest.low,
    };
  }

  return { runs, totals, health: healthBlock, scanned: entries.length };
}

const trendArrow = (delta: number | null): string =>
  delta === null ? '·' : delta > 0 ? `▲ +${delta}` : delta < 0 ? `▼ ${delta}` : '= 0';

/** Render a recap as the terminal digest. `limit` caps the listed runs. */
export function formatRecap(model: RecapModel, limit = 10): string {
  const lines: string[] = [];
  const { totals, health } = model;

  if (totals.runs === 0) {
    lines.push('recap: no runs journaled yet — run `archon run <goal>`');
  } else {
    lines.push(
      `recap: ${totals.runs} run(s) — ${totals.merged} merged, ${totals.unmerged} unmerged · $${totals.costUsd.toFixed(4)} total`,
    );
    for (const r of model.runs.slice(0, limit)) {
      const mark = r.merged ? '✓' : '✗';
      const cost = r.costUsd > 0 ? ` · $${r.costUsd.toFixed(4)}` : '';
      lines.push(`  ${mark} ${r.taskId}  ${r.at}  (${r.steps} step${r.steps === 1 ? '' : 's'}${cost})`);
      lines.push(`      ${r.summary}`);
      if (!r.merged) lines.push(`      → ${r.outcome}`);
    }
    if (model.runs.length > limit) lines.push(`  …and ${model.runs.length - limit} more`);
  }

  if (health) {
    lines.push(
      `health: ${health.score}/100  ${trendArrow(health.delta)}  ` +
        `(${health.high} high · ${health.medium} med · ${health.low} low)`,
    );
  }
  return lines.join('\n');
}
