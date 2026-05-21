#!/usr/bin/env node
// Archon CLI — command surface for the MVP. `plan` and `run` are live (M6);
// `index`/`status` remain tracked stubs (see docs/ROADMAP.md).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CognitionLoop } from './cognition/loop';
import { Executor } from './cognition/executor';
import { Planner } from './cognition/planner';
import { Reflector } from './cognition/reflector';
import { ScaffoldStrategy } from './cognition/scaffold-strategy';
import type { CognitivePlan } from './cognition/types';
import { Verifier } from './cognition/verifier';
import { loadComputeCore } from './core/compute';
import type { Profile, StepResult, Task } from './core/types';
import { AuditLog } from './effecting/audit-log';
import { CapabilityBroker } from './effecting/capability-broker';
import { loadPolicy, PolicyEngine } from './effecting/policy-engine';
import { Transaction } from './effecting/transaction';
import { MemoryStore } from './memory/store';
import { Indexer } from './sensing/indexer';
import { IndexStore } from './sensing/store';
import { SymbolGraph } from './sensing/symbol-graph';
import { loadConfig } from './services/config';
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
  const cog = await new Planner(new ScaffoldStrategy()).plan(makeTask(goal, 'safe'));
  printPlan(cog);
}

async function runRun(goal: string): Promise<void> {
  if (!goal) return usageError('run <goal>');
  const root = process.cwd();
  const config = await loadConfig(root);
  const doc = loadPolicy(readFileSync(join(root, config.paths.policy), 'utf8'));
  const audit = new AuditLog();
  // `trusted` so the worktree transaction's git ops are permitted; the broker
  // still gates each one, and writes are confined to the worktree.
  const brokerAt = (cwd: string): CapabilityBroker =>
    new CapabilityBroker(new PolicyEngine(doc, 'trusted'), audit, cwd);
  const memory = new MemoryStore(join(root, config.paths.memory));
  const journal = new TaskJournal(join(root, config.paths.journal));

  const loop = new CognitionLoop({
    planner: new Planner(new ScaffoldStrategy()),
    transaction: new Transaction(brokerAt(root), root, join(root, '.archon/worktrees')),
    reflector: new Reflector(memory),
    journal,
    executorFor: (worktree, taskId) => new Executor(brokerAt(worktree), taskId),
    verifierFor: (worktree) => new Verifier(brokerAt(worktree)),
  });

  try {
    printResults(await loop.run(makeTask(goal, 'trusted')));
  } finally {
    memory.close();
    journal.close();
  }
}

async function runStatus(): Promise<void> {
  const root = process.cwd();
  const config = await loadConfig(root);
  const b = config.budgets;
  console.log(`profile: ${config.profile}   budgets: $${b.perTaskUsd}/task · $${b.globalDailyUsd}/day · ${b.contextTokensMax} ctx-tok`);

  // Open read-only intent: don't create the db just to report an empty journal.
  const journalPath = join(root, config.paths.journal);
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
  }
}

async function runIndex(): Promise<void> {
  const root = process.cwd();
  const config = await loadConfig(root);
  const core = await loadComputeCore();
  const store = new IndexStore(join(root, config.paths.index));
  try {
    const indexer = new Indexer(core, store, new SymbolGraph(store), root);
    const dirty = await indexer.dirtyPaths();
    await indexer.reindex(dirty);
    console.log(
      `indexed ${dirty.length} changed path(s) → ${store.allSymbols().length} symbols across ${store.allFileHashes().length} file(s)`,
    );
  } finally {
    store.close();
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
