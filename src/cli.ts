#!/usr/bin/env node
// Archon CLI — command surface for the MVP. All four commands are live:
// `index` (M1), `plan`/`run` (M6), `status` (M0). Every command is composed
// through the single runtime root (`buildRuntime`).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CognitivePlan } from './cognition/types';
import type { Profile, StepResult, Task } from './core/types';
import { buildRuntime } from './runtime';
import { TaskJournal } from './services/task-journal';

const HELP = `archon — constrained AI staff-engineer runtime (MVP)

Usage:
  archon index            Incrementally index changed files            (M1)
  archon plan <goal>      Produce a plan tree — no writes               (M6)
  archon run <goal>       Plan -> act -> verify under a worktree tx     (M6)
  archon status           Show task journal + budgets                   (M0)
  archon --help           Show this help

See docs/ROADMAP.md and AGENTS.md.`;

const makeTask = (goal: string, profile: Profile): Task => ({
  id: `t-${Date.now().toString(36)}`,
  goal,
  profile,
  createdAt: new Date().toISOString(),
});

const plannerLabel = (llm: boolean): string =>
  `planner: ${llm ? 'llm (provider-router)' : 'deterministic (scaffold)'}`;

function printPlan(cog: CognitivePlan): void {
  console.log(`plan ${cog.plan.taskId}: ${cog.plan.rationale}`);
  for (const step of cog.plan.steps) {
    console.log(`  • ${step.intent}  [${step.capability.action} ${step.capability.target}] (reversible)`);
  }
  for (const check of cog.checks) console.log(`  ✓ verify ${check.name}: ${check.argv.join(' ')}`);
}

function printResults(results: StepResult[]): void {
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

async function runPlan(goal: string): Promise<void> {
  if (!goal) return usageError('plan <goal>');
  const runtime = await buildRuntime(process.cwd());
  try {
    console.log(plannerLabel(runtime.llmPlanning));
    printPlan(await runtime.planner().plan(makeTask(goal, runtime.config.profile)));
  } finally {
    runtime.close();
  }
}

async function runRun(goal: string): Promise<void> {
  if (!goal) return usageError('run <goal>');
  const runtime = await buildRuntime(process.cwd());
  try {
    console.log(plannerLabel(runtime.llmPlanning));
    printResults(await runtime.loop().run(makeTask(goal, 'trusted')));
  } finally {
    runtime.close();
  }
}

async function runIndex(): Promise<void> {
  const runtime = await buildRuntime(process.cwd());
  const { indexer, store, close } = await runtime.indexer();
  try {
    const dirty = await indexer.dirtyPaths();
    await indexer.reindex(dirty);
    console.log(
      `indexed ${dirty.length} changed path(s) → ${store.allSymbols().length} symbols across ${store.allFileHashes().length} file(s)`,
    );
  } finally {
    close();
    runtime.close();
  }
}

async function runStatus(): Promise<void> {
  const runtime = await buildRuntime(process.cwd());
  const b = runtime.config.budgets;
  console.log(
    `profile: ${runtime.config.profile}   budgets: $${b.perTaskUsd}/task · $${b.globalDailyUsd}/day · ${b.contextTokensMax} ctx-tok`,
  );

  // Read-only intent: don't create the db just to report an empty journal, so
  // open the real path only when it already exists (else an ephemeral one).
  const journalPath = join(runtime.root, runtime.config.paths.journal);
  const journal = new TaskJournal(existsSync(journalPath) ? journalPath : ':memory:');
  try {
    const recent = journal.recent(15);
    if (recent.length === 0) {
      console.log('journal: (empty — run `archon run <goal>`)');
      return;
    }
    console.log(`journal: ${recent.length} most-recent entries (newest first):`);
    for (const e of recent) console.log(`  #${e.seq} ${e.ts} ${e.taskId} ${e.kind}`);
  } finally {
    journal.close();
    runtime.close();
  }
}

function usageError(form: string): void {
  console.error(`usage: archon ${form}`);
  process.exitCode = 1;
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const goal = rest.join(' ').trim();
  switch (cmd) {
    case undefined:
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    case 'index':
      return runIndex();
    case 'plan':
      return runPlan(goal);
    case 'run':
      return runRun(goal);
    case 'status':
      return runStatus();
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`[archon] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
