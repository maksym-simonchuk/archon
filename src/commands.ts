// Shared command implementations + formatters used by both the one-shot CLI
// (src/cli.ts) and the interactive shell (src/shell.ts). Each command takes an
// already-built Runtime and does NOT own its lifecycle — the caller closes it.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CognitivePlan } from './cognition/types';
import type { JournalEntry, Profile, StepResult, Task } from './core/types';
import type { Runtime } from './runtime';
import { TaskJournal } from './services/task-journal';

export const makeTask = (goal: string, profile: Profile): Task => ({
  id: `t-${Date.now().toString(36)}`,
  goal,
  profile,
  createdAt: new Date().toISOString(),
});

export const plannerLabel = (llm: boolean): string =>
  `planner: ${llm ? 'llm (provider-router)' : 'deterministic (scaffold)'}`;

export function printPlan(cog: CognitivePlan): void {
  console.log(`plan ${cog.plan.taskId}: ${cog.plan.rationale}`);
  for (const step of cog.plan.steps) {
    console.log(`  • ${step.intent}  [${step.capability.action} ${step.capability.target}] (reversible)`);
  }
  for (const check of cog.checks) console.log(`  ✓ verify ${check.name}: ${check.argv.join(' ')}`);
}

export function printResults(results: StepResult[]): void {
  for (const r of results) {
    const mark = r.verdict.passed ? '✓' : '✗';
    const where = r.diff ? ` (${r.diff.files.join(', ')})` : '';
    console.log(`  ${mark} ${r.stepId}${where}`);
    for (const c of r.verdict.checks) {
      if (!c.passed && c.output) console.log(`      ${c.name}: ${c.output}`);
    }
  }
  const merged = results.every((r) => r.verdict.passed);
  console.log(merged ? 'run: merged (verified)' : 'run: discarded (verify failed; main tree untouched)');
}

/** A short payload summary for the cost / verdict / decision journal kinds. */
export function journalHint(e: JournalEntry): string {
  const p = e.payload;
  if (typeof p !== 'object' || p === null) return '';
  const r = p as Record<string, unknown>;
  switch (e.kind) {
    case 'cost':
      return typeof r.usd === 'number' ? `  $${r.usd.toFixed(4)}` : '';
    case 'verdict':
      return typeof r.passed === 'boolean' ? `  passed=${r.passed}` : '';
    case 'decision':
      return typeof r.outcome === 'string' ? `  ${r.outcome}` : '';
    default:
      return '';
  }
}

export async function cmdPlan(rt: Runtime, goal: string): Promise<void> {
  console.log(plannerLabel(rt.llmPlanning));
  const task = makeTask(goal, rt.config.profile);
  printPlan(await rt.planner().plan(task, await rt.context(task)));
}

export async function cmdRun(rt: Runtime, goal: string): Promise<void> {
  console.log(plannerLabel(rt.llmPlanning));
  const task = makeTask(goal, 'trusted');
  printResults(await rt.loop().run(task, await rt.context(task)));
}

export async function cmdIndex(rt: Runtime): Promise<void> {
  const { indexer, store, close } = await rt.indexer();
  try {
    const dirty = await indexer.dirtyPaths();
    await indexer.reindex(dirty);
    console.log(
      `indexed ${dirty.length} changed path(s) → ${store.allSymbols().length} symbols across ${store.allFileHashes().length} file(s)`,
    );
  } finally {
    close();
  }
}

export async function cmdStatus(rt: Runtime): Promise<void> {
  const b = rt.config.budgets;
  console.log(
    `profile: ${rt.config.profile}   budgets: $${b.perTaskUsd}/task · $${b.globalDailyUsd}/day · ${b.contextTokensMax} ctx-tok`,
  );

  // Read-only intent: don't create the db just to report an empty journal, so
  // open the real path only when it already exists (else an ephemeral one).
  const journalPath = join(rt.root, rt.config.paths.journal);
  const journal = new TaskJournal(existsSync(journalPath) ? journalPath : ':memory:');
  try {
    const recent = journal.recent(15);
    if (recent.length === 0) {
      console.log('journal: (empty — run `archon run <goal>`)');
      return;
    }
    console.log(`journal: ${recent.length} most-recent entries (newest first):`);
    for (const e of recent) console.log(`  #${e.seq} ${e.ts} ${e.taskId} ${e.kind}${journalHint(e)}`);
  } finally {
    journal.close();
  }
}

/** Recall prior episodes for a goal, semantically reranked by the bundled retriever. */
export async function cmdMemory(rt: Runtime, goal: string): Promise<void> {
  const retriever = await rt.retriever('episodic', goal);
  const hits = await retriever.retrieve(goal, 5);
  if (hits.length === 0) {
    console.log(`memory: no prior episodes for "${goal}"`);
    return;
  }
  console.log(`memory: ${hits.length} prior episode(s) for "${goal}" (most relevant first):`);
  for (const h of hits) console.log(`  - ${h}`);
}
