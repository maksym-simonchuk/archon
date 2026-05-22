// Shared command implementations + formatters used by both the one-shot CLI
// (src/cli.ts) and the interactive shell (src/shell.ts). Each command takes an
// already-built Runtime and does NOT own its lifecycle — the caller closes it.

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { CognitivePlan } from './cognition/types';
import type { ArchitecturalFingerprint, JournalEntry, MemoryTier, PolicyDecision, Profile, StepResult, Task } from './core/types';
import { PromotionEngine } from './memory/promotion';
import type { SkillPlugin } from './plugins/abi';
import type { Runtime } from './runtime';
import { type BoundaryModel, formatBoundaries, inferBoundaries, moduleOf } from './sensing/boundaries';
import { assessSignificance, type Decision, formatDecisions, matchesQuery, parseAdr, proposeAdr } from './memory/decisions';
import { analyzeEvolution, type EvolutionModel, formatEvolution } from './sensing/evolution';
import { detectViolations, formatViolations, moduleConfidence, type ViolationReport } from './sensing/violations';
import { type FileRisk, formatRisk, scoreRisk } from './cognition/risk';
import { analyzeStructure } from './sensing/structural-analyzer';
import { formatPhilosophy, inferPhilosophy, type PhilosophyProfile } from './sensing/philosophy';
import { assessPreservation, type ChangeKind, formatPreservation } from './cognition/preservation';
import { type AgentSpec, formatAgents, generateAgents } from './cognition/agent-factory';
import { agentBriefing, selectAgent } from './cognition/agent-runtime';
import { formatImprovements, type ImprovementAction, proposeImprovements } from './cognition/improve';
import { formatSimulation } from './cognition/simulation';
import { assembleSimulation, fingerprintAndModel, philosophySignals } from './simulation-assembly';
import { evaluatePreHooks, formatHooks, postHookChecks } from './effecting/hooks';
import { IndexStore } from './sensing/store';
import { changedSince, formatWatchTick } from './sensing/watch';
import { SymbolGraph, type SymbolNeighbors } from './sensing/symbol-graph';
import { TaskJournal } from './services/task-journal';
import { formatRecap, recap } from './services/recap';

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

/**
 * A fuller one-line rendering of a journal entry's payload, by kind — for the
 * per-task replay view (`archon status <taskId>`). Richer than `journalHint`
 * (which is only a suffix on the cross-task recent list): it unpacks the plan's
 * steps, a diff's files, and a verdict's failing checks. Defensive against
 * unknown payload shapes since entries are plain JSON read back from SQLite.
 */
export function journalDetail(e: JournalEntry): string {
  const p = (typeof e.payload === 'object' && e.payload !== null ? e.payload : {}) as Record<string, unknown>;
  switch (e.kind) {
    case 'plan': {
      const steps = Array.isArray(p.steps) ? p.steps : [];
      const rationale = typeof p.rationale === 'string' ? p.rationale : '';
      return steps.length ? `${rationale} — steps: ${steps.join(' · ')}` : rationale;
    }
    case 'step':
      return `${p.stepId ?? '?'}  passed=${p.passed ?? '?'}`;
    case 'diff':
      return `${Array.isArray(p.files) ? p.files.join(', ') : ''} (+${p.added ?? 0}/-${p.removed ?? 0})`;
    case 'verdict': {
      const checks = Array.isArray(p.checks) ? (p.checks as { name: string; passed: boolean }[]) : [];
      const failed = checks.filter((c) => !c.passed).map((c) => c.name);
      return `passed=${p.passed}${failed.length ? `  failed: ${failed.join(', ')}` : ''}`;
    }
    case 'decision':
      return typeof p.outcome === 'string' ? p.outcome : '';
    case 'cost':
      return typeof p.usd === 'number' ? `$${p.usd.toFixed(4)}` : '';
    default:
      return '';
  }
}

/** One prior question/answer pair, threaded back into a later /ask for continuity. */
export interface AskTurn {
  question: string;
  answer: string;
}

/**
 * Lift `--<flag> <value>` out of an argv token list, returning the value (if
 * present) and the surviving tokens. A dangling `--<flag>` with no following
 * value is dropped (treated as absent). Used to peel `--skill <name>` off
 * `plan`/`run` before the remainder is joined into the goal — shared by the CLI
 * and the shell so both surfaces parse a flag identically.
 */
export function extractFlag(tokens: string[], flag: string): { value?: string; rest: string[] } {
  const i = tokens.indexOf(flag);
  if (i === -1) return { rest: tokens };
  const value = tokens[i + 1];
  if (value === undefined) return { rest: tokens.slice(0, i) }; // dangling flag → drop it
  return { value, rest: [...tokens.slice(0, i), ...tokens.slice(i + 2)] };
}

const FILE_REF = /(?:^|\s)@(\S+)/g;
const MAX_FILE_CHARS = 8_000; // cap each attached file so a giant one can't blow the prompt/budget
const FENCE = '```';

/**
 * Extract `@path` references from /ask text (deduped, order-preserving). The `@`
 * only counts at a word boundary, so `user@host` is not a reference, and trailing
 * sentence punctuation is trimmed so `@src/x.ts.` resolves to `src/x.ts`.
 */
export function extractFileRefs(text: string): string[] {
  const refs: string[] = [];
  for (const m of text.matchAll(FILE_REF)) {
    const ref = m[1].replace(/[.,;:!?)\]]+$/, '');
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/**
 * Read each `@file` reference through the broker and render it as a fenced
 * context block. Routing reads through the broker (not raw `fs`) is the whole
 * point: `@.env` and other secret globs are denied by policy, so a file destined
 * for an external LLM prompt can't become an exfil path; repo-escape is blocked
 * too. Each decision is surfaced to the user on stderr (diagnostics, not data —
 * so `plan --json` / `ask` stay pipeable), and oversized files are truncated.
 */
async function attachFiles(rt: Runtime, refs: string[]): Promise<string> {
  if (refs.length === 0) return '';
  const broker = rt.brokerAt(rt.root);
  const blocks: string[] = [];
  for (const ref of refs) {
    const r = await broker.fsRead(ref, { reason: 'ask: @file context' });
    if (r.ok) {
      const body = r.value.length > MAX_FILE_CHARS ? `${r.value.slice(0, MAX_FILE_CHARS)}\n…(truncated)\n` : r.value;
      blocks.push(`# File: ${ref}\n${FENCE}\n${body}${FENCE}`);
      console.error(`  + attached @${ref} (${r.value.length} chars)`);
    } else {
      const why = r.error.message ?? r.error.code;
      blocks.push(`# File: ${ref}\n(unavailable: ${why})`);
      console.error(`  ⚠ skipped @${ref}: ${why}`);
    }
  }
  return `Attached files:\n${blocks.join('\n\n')}\n\n`;
}

/**
 * Stream a freeform answer from the provider, token by token (the shell's
 * "typing" feel). Read-only: it routes through `summarize` (a cheap model) and
 * proposes no effects. Requires an LLM provider — the offline scaffolder cannot
 * stream. Prior turns (the shell's session transcript) are woven into the prompt
 * so the conversation carries context; the one-shot CLI passes none. `@path`
 * tokens in the question pull file contents into the prompt — read through the
 * broker, so secrets are denied. An optional `signal` makes the stream
 * cancellable (Ctrl-C): on abort we keep the partial text but footer it as
 * cancelled and charge nothing. Returns the answer so the caller can append it
 * to the transcript (empty string when no provider is configured).
 */
export async function cmdAsk(
  rt: Runtime,
  question: string,
  history: readonly AskTurn[] = [],
  signal?: AbortSignal,
): Promise<string> {
  if (!rt.llmPlanning) {
    console.log('ask: no LLM provider configured — set a provider key (see `archon doctor`)');
    return '';
  }
  const attached = await attachFiles(rt, extractFileRefs(question));
  const prior = history.map((t) => `Q: ${t.question}\nA: ${t.answer}`).join('\n\n');
  const prompt =
    'Answer concisely for an engineer working in this repository.\n\n' +
    attached +
    (prior ? `Conversation so far:\n${prior}\n\n` : '') +
    `Question: ${question}\n`;
  const { modelId, text, costUsd, aborted } = await rt.router.streamComplete(
    { taskClass: 'summarize', prompt, maxTokens: 1024 },
    (chunk) => process.stdout.write(chunk),
    signal,
  );
  process.stdout.write('\n');
  console.log(aborted ? `— ${modelId} (cancelled)` : `— ${modelId} ($${costUsd.toFixed(4)})`);
  return text;
}

/**
 * The context block for an explicitly-selected skill `name`: its playbook, framed
 * as a procedure for the planner to apply — or '' (with a note) when no such
 * skill is loaded. Selection is always explicit (`--skill`), never automatic:
 * Archon adapts to the project, so a procedure is imposed only when the operator
 * asks for it. See ADR-0009.
 */
async function skillPlaybook(rt: Runtime, name: string): Promise<string> {
  const skill = (await rt.pluginHost())
    .list()
    .find((p): p is SkillPlugin => p.kind === 'skill' && p.manifest.name === name);
  if (!skill) {
    console.error(`  ⚠ skill "${name}" not loaded — planning without it (\`archon skills\` lists them)`);
    return '';
  }
  console.error(`  + applying skill "${name}"`);
  return `# Skill: ${skill.manifest.name}\nApply this playbook where it fits the task:\n${skill.playbook}\n\n`;
}

/**
 * Context fed to the planner: an explicitly-selected `--skill` playbook (if any),
 * then any `@file` attachments named in the goal, then the budgeted repo-map.
 * Attachments are read through the broker (so the secret-deny applies) and the
 * skill is resolved only when an LLM planner is active — the deterministic
 * scaffolder ignores context, so doing that work for it would be wasted and
 * confusing. Exported for direct testing of the attach/skill/skip branches.
 */
export async function planContext(rt: Runtime, task: Task, goal: string, skill?: string): Promise<string> {
  if (!rt.llmPlanning) return rt.context(task); // scaffolder ignores context — skip @file reads + skills
  const playbook = skill ? await skillPlaybook(rt, skill) : '';
  const attached = await attachFiles(rt, extractFileRefs(goal));
  return playbook + attached + (await rt.context(task));
}

/** Machine-readable shape of `archon plan --json` (a stable automation contract). */
export interface PlanReport {
  taskId: string;
  rationale: string;
  steps: { intent: string; action: string; target: string }[];
  checks: { name: string; argv: string[] }[];
}

export async function cmdPlan(rt: Runtime, goal: string, opts: { skill?: string; json?: boolean } = {}): Promise<void> {
  const task = makeTask(goal, rt.config.profile);
  const cog = await rt.planner().plan(task, await planContext(rt, task, goal, opts.skill));
  if (opts.json) {
    // stdout carries only this document — diagnostics (@file / --skill notes) go
    // to stderr — so `archon plan --json | jq` is safe.
    const report: PlanReport = {
      taskId: cog.plan.taskId,
      rationale: cog.plan.rationale,
      steps: cog.plan.steps.map((s) => ({ intent: s.intent, action: s.capability.action, target: s.capability.target })),
      checks: cog.checks.map((c) => ({ name: c.name, argv: c.argv })),
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(plannerLabel(rt.llmPlanning));
  printPlan(cog);
}

/** Machine-readable shape of `archon run --json` (a stable automation contract). */
export interface RunReport {
  taskId: string;
  goal: string;
  /** True only if every step passed and the worktree was merged. */
  merged: boolean;
  steps: { stepId: string; passed: boolean; files: string[]; failingChecks: string[] }[];
}

export async function cmdRun(
  rt: Runtime,
  goal: string,
  opts: { skill?: string; json?: boolean; force?: boolean } = {},
): Promise<void> {
  const task = makeTask(goal, 'trusted');
  const context = await planContext(rt, task, goal, opts.skill);
  if (opts.json) {
    // stdout carries only this document — planContext diagnostics go to stderr —
    // so `archon run --json | jq .merged` is a safe CI gate.
    const results = await rt.loop(undefined, { force: opts.force }).run(task, context);
    const report: RunReport = {
      taskId: task.id,
      goal,
      merged: results.every((r) => r.verdict.passed),
      steps: results.map((r) => ({
        stepId: r.stepId,
        passed: r.verdict.passed,
        files: r.diff?.files ?? [],
        failingChecks: r.verdict.checks.filter((c) => !c.passed).map((c) => c.name),
      })),
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(plannerLabel(rt.llmPlanning));
  // Print the id before running so it's known even if the loop throws mid-run —
  // the partial journal is still inspectable via `archon status <id>`.
  console.log(`run ${task.id}: ${goal}`);
  printResults(await rt.loop(undefined, { force: opts.force }).run(task, context));
  console.log(`  replay: archon status ${task.id}`);
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

/**
 * One incremental watch tick (M22 daemon runtime). Reindexes the working tree's
 * dirty set — hash-gated, so unchanged files are skipped and changed files are
 * reparsed; never a full rescan (ADR-0005) — then, only when the dirty set moved
 * since `prev`, recomputes the architecture-health score and prints a one-line
 * delta. Returns the new dirty set so the caller (the TUI's background poller)
 * can thread it into the next tick. A single tick is the testable unit; the
 * `watch` daemon is just this on a timer. Read-only git/fs + sensing only.
 */
export async function cmdWatch(rt: Runtime, prev: ReadonlySet<string> = new Set()): Promise<ReadonlySet<string>> {
  const { indexer, store, close } = await rt.indexer();
  try {
    const dirty = await indexer.dirtyPaths();
    const delta = changedSince(prev, dirty);
    await indexer.reindex(dirty); // hash-gated: reparses only files whose content changed
    if (!delta.quiet) {
      const { healthScore } = detectViolations(buildViolationInput(store));
      console.log(formatWatchTick(delta, healthScore));
    }
    return delta.current;
  } finally {
    close();
  }
}

/**
 * Surface the sensing plane's blast radius: given a file (or a fully-qualified
 * symbol id), which symbols transitively DEPEND ON it — i.e. what a change here
 * could break. This is the same reverse-reachability the policy uses to size its
 * ask-threshold (ADR-0005), exposed for inspection. Read-only and WASM-free: it
 * opens the existing index directly (like `status` with the journal) and never
 * creates it — run `archon index` first.
 */
/** Machine-readable shape of `archon impact --json` (a stable automation contract). */
export interface ImpactReport {
  target: string;
  /** Symbols seeded from the target (every symbol a file defines, or the one symbol). */
  seeds: string[];
  /** Downstream symbols that transitively depend on the seeds (excludes the seeds). */
  dependents: string[];
  /** Every file in the blast radius. */
  files: string[];
}

export async function cmdImpact(rt: Runtime, target: string, opts: { json?: boolean } = {}): Promise<void> {
  const empty = (): ImpactReport => ({ target, seeds: [], dependents: [], files: [] });
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    if (opts.json) console.log(JSON.stringify(empty(), null, 2));
    else console.log('impact: no index yet — run `archon index` first');
    return;
  }
  const store = new IndexStore(indexPath);
  try {
    const all = store.allSymbols();
    // Accept either a file path (seed with every symbol it defines) or one symbol id.
    const fileSeeds = all.filter((s) => s.file === target).map((s) => s.name);
    const seeds = fileSeeds.length > 0 ? fileSeeds : all.filter((s) => s.name === target).map((s) => s.name);
    if (seeds.length === 0) {
      if (opts.json) {
        console.log(JSON.stringify(empty(), null, 2));
        return;
      }
      // Distinguish "indexed but symbol-less" (e.g. a types-only file — the
      // extractor tracks functions/classes/consts) from a genuinely unknown path.
      const indexed = store.allFileHashes().some((f) => f.path === target);
      console.log(
        indexed
          ? `impact: ${target} is indexed but defines no extractable symbols (functions/classes/consts only)`
          : `impact: "${target}" is not an indexed file or symbol (run \`archon index\` to refresh)`,
      );
      return;
    }
    const radius = await new SymbolGraph(store).blastRadius(seeds);
    // blastRadius includes the seeds themselves; the dependents are what's at risk.
    const dependents = radius.symbols.filter((s) => !seeds.includes(s));
    if (opts.json) {
      const report: ImpactReport = { target, seeds, dependents, files: radius.files };
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `impact of ${target}: ${seeds.length} symbol(s) → ${dependents.length} dependent(s) across ${radius.files.length} file(s):`,
    );
    for (const f of radius.files) console.log(`  - ${f}${f === target ? '  (source)' : ''}`);
  } finally {
    store.close();
  }
}

/** The symbol segment of a qualified id (`src/x.ts#foo` → `foo`); the whole string if unqualified. */
const bareName = (qualified: string): string => qualified.slice(qualified.indexOf('#') + 1);

/** Print one direction of a symbol's one-hop neighborhood (or "(none)" when empty). */
function printNeighbors(label: string, edges: SymbolNeighbors['dependsOn']): void {
  if (edges.length === 0) {
    console.log(`  ${label}: (none)`);
    return;
  }
  console.log(`  ${label} (${edges.length}):`);
  for (const e of edges) console.log(`    - ${e.name}  [${e.kind}]`);
}

/**
 * Explain one symbol from the index: where it's defined, what it directly depends
 * on (its callees/imports), and what directly depends on it (its callers/tests) —
 * the one-hop neighborhood, complementing `impact`'s transitive reverse-reachability.
 * Accepts a fully-qualified id (`src/x.ts#foo`) or a bare name (`foo`); a bare name
 * defined in several files is reported as ambiguous so the operator can qualify it.
 * Read-only and WASM-free: opens the existing index directly and never creates it.
 */
/** Machine-readable shape of `archon explain --json` (a stable automation contract). */
export interface ExplainReport {
  query: string;
  /** Qualified id the query resolved to, or null if unknown/ambiguous. */
  resolved: string | null;
  kind: string | null;
  file: string | null;
  dependsOn: SymbolNeighbors['dependsOn'];
  dependedOnBy: SymbolNeighbors['dependedOnBy'];
  /** Qualified ids when a bare name matched several files (else empty). */
  candidates: string[];
}

export async function cmdExplain(rt: Runtime, query: string, opts: { json?: boolean } = {}): Promise<void> {
  const empty = (candidates: string[] = []): ExplainReport => ({
    query,
    resolved: null,
    kind: null,
    file: null,
    dependsOn: [],
    dependedOnBy: [],
    candidates,
  });
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    if (opts.json) console.log(JSON.stringify(empty(), null, 2));
    else console.log('explain: no index yet — run `archon index` first');
    return;
  }
  const store = new IndexStore(indexPath);
  try {
    const all = store.allSymbols();
    // Resolve to a single qualified id: exact match first, else by bare name
    // (the segment after '#'), which may collide across files.
    const exact = all.find((s) => s.name === query);
    const matches = exact ? [exact] : all.filter((s) => bareName(s.name) === query);
    if (matches.length === 0) {
      if (opts.json) console.log(JSON.stringify(empty(), null, 2));
      else
        console.log(`explain: "${query}" is not an indexed symbol (try \`archon impact <file>\`, or re-run \`archon index\`)`);
      return;
    }
    if (matches.length > 1) {
      if (opts.json) {
        console.log(JSON.stringify(empty(matches.map((m) => m.name)), null, 2));
        return;
      }
      console.log(`explain: "${query}" is ambiguous — ${matches.length} definitions; qualify one:`);
      for (const m of matches) console.log(`  - ${m.name}  [${m.kind}]`);
      return;
    }
    const sym = matches[0];
    const { dependsOn, dependedOnBy } = new SymbolGraph(store).neighbors(sym.name);
    if (opts.json) {
      const report: ExplainReport = {
        query,
        resolved: sym.name,
        kind: sym.kind,
        file: sym.file,
        dependsOn,
        dependedOnBy,
        candidates: [],
      };
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`${sym.name}  [${sym.kind}]  defined in ${sym.file}`);
    printNeighbors('depends on', dependsOn); // its callees / imports
    printNeighbors('used by', dependedOnBy); // its callers / tests
  } finally {
    store.close();
  }
}

/**
 * A structural overview of the indexed symbol graph: how big it is (files /
 * symbols / edges, with an edge-kind breakdown) and which symbols are most
 * depended-on — the load-bearing nodes worth knowing before a change, and the
 * entry points for `explain` / `impact`. (Distinct from the planner's budgeted
 * repo-map in `rt.context` — this reports the raw graph, not a prompt.) Read-only
 * and WASM-free: opens the existing index directly and never creates it.
 */
/** Machine-readable shape of `archon map --json` (a stable automation contract). */
export interface MapReport {
  files: number;
  symbols: number;
  edges: number;
  /** Edge count keyed by kind (only kinds the extractor actually emitted). */
  edgesByKind: Record<string, number>;
  /** Most depended-on symbols, ranked by distinct-dependent count. */
  hot: { name: string; dependents: number }[];
}

export async function cmdMap(rt: Runtime, opts: { json?: boolean } = {}): Promise<void> {
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    if (opts.json) console.log(JSON.stringify({ files: 0, symbols: 0, edges: 0, edgesByKind: {}, hot: [] }, null, 2));
    else console.log('map: no index yet — run `archon index` first');
    return;
  }
  const store = new IndexStore(indexPath);
  try {
    const files = store.allFileHashes().length;
    const symbols = store.allSymbols();
    const edges = store.loadEdges();
    // Edge-kind breakdown — count whatever kinds the extractor actually emitted.
    const byKind = new Map<string, number>();
    for (const e of edges) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
    const hot = new SymbolGraph(store).hotNodes(10);
    if (opts.json) {
      const report: MapReport = {
        files,
        symbols: symbols.length,
        edges: edges.length,
        edgesByKind: Object.fromEntries(byKind),
        hot,
      };
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (symbols.length === 0) {
      console.log(`map: ${files} file(s) indexed, but no symbols yet (run \`archon index\`)`);
      return;
    }
    console.log(`repo map: ${files} file(s) · ${symbols.length} symbol(s) · ${edges.length} edge(s)`);
    const kinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`);
    if (kinds.length > 0) console.log(`  edges: ${kinds.join(' · ')}`);
    if (hot.length === 0) {
      console.log('  most depended-on: (none — no dependency edges yet)');
      return;
    }
    console.log('  most depended-on (distinct dependents):');
    hot.forEach((h, i) => console.log(`    ${String(i + 1).padStart(2)}. ${h.name}  ←${h.dependents}`));
  } finally {
    store.close();
  }
}

/**
 * Surface the inferred bounded contexts (M9): cluster the file-import graph
 * into modules and report fan-in/out, instability, coupling hotspots,
 * god-module candidates, and circular dependencies. Read-only and WASM-free —
 * opens the existing index directly and re-derives the model each run (run
 * `archon index` first). The import edges it reads are built incrementally by
 * the indexer (M8.5), so boundaries reflect the last-indexed state.
 */
export async function cmdBoundaries(rt: Runtime, opts: { json?: boolean } = {}): Promise<void> {
  const empty = (): BoundaryModel => ({ modules: [], couplingHotspots: [], godModules: [], cycles: [] });
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    if (opts.json) console.log(JSON.stringify(empty(), null, 2));
    else console.log('boundaries: no index yet — run `archon index` first');
    return;
  }
  const store = new IndexStore(indexPath);
  try {
    const model = inferBoundaries(store.allFileHashes(), store.loadFileEdges());
    if (opts.json) console.log(JSON.stringify(model, null, 2));
    else console.log(formatBoundaries(model));
  } finally {
    store.close();
  }
}

/**
 * Render the machine-readable intelligence layer (M10): the persisted boundary
 * model (`module_intelligence`, written by `archon init`), falling back to a
 * live derivation from the current index. The graph view of `memory` — where
 * `memory list` shows stored records and `memory <goal>` recalls episodes, this
 * shows the architectural model the runtime reasons over. Read-only.
 */
export async function cmdMemoryGraph(rt: Runtime, opts: { json?: boolean } = {}): Promise<void> {
  const empty = (): BoundaryModel => ({ modules: [], couplingHotspots: [], godModules: [], cycles: [] });
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    if (opts.json) console.log(JSON.stringify(empty(), null, 2));
    else console.log('memory --graph: no index yet — run `archon index` then `archon init`');
    return;
  }
  const store = new IndexStore(indexPath);
  try {
    const model = store.loadModuleIntelligence() ?? inferBoundaries(store.allFileHashes(), store.loadFileEdges());
    if (opts.json) console.log(JSON.stringify(model, null, 2));
    else console.log(formatBoundaries(model));
  } finally {
    store.close();
  }
}

/**
 * Architecture-health findings (M12): detect circular dependencies, god
 * modules, stable-dependency violations, and missing tests over the indexed
 * graph, ranked by severity × criticality. Read-only — derives from the
 * existing index (run `archon index` first). The shared detector also backs the
 * health score in `doctor`.
 */
export async function cmdViolations(rt: Runtime, opts: { json?: boolean } = {}): Promise<void> {
  const empty = (): ViolationReport => ({ violations: [], healthScore: 100, countsBySeverity: { high: 0, medium: 0, low: 0 } });
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    if (opts.json) console.log(JSON.stringify(empty(), null, 2));
    else console.log('violations: no index yet — run `archon index` first');
    return;
  }
  const store = new IndexStore(indexPath);
  try {
    const report = detectViolations(buildViolationInput(store));
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatViolations(report));
  } finally {
    store.close();
  }
}

/**
 * Risk assessment for a file (M13, read-only): combine its blast radius with its
 * module's criticality and confidence into a low/medium/high/critical level with
 * a rationale. Advisory only — does not touch the Policy Engine. Read-only;
 * derives from the existing index (run `archon index` first).
 */
export async function cmdRisk(rt: Runtime, target: string, opts: { json?: boolean } = {}): Promise<void> {
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    if (opts.json) console.log(JSON.stringify(null));
    else console.log('risk: no index yet — run `archon index` first');
    return;
  }
  const store = new IndexStore(indexPath);
  try {
    const all = store.allSymbols();
    const seeds = all.filter((s) => s.file === target).map((s) => s.name);
    const indexed = store.allFileHashes().some((f) => f.path === target);
    if (!indexed) {
      if (opts.json) console.log(JSON.stringify(null));
      else console.log(`risk: "${target}" is not an indexed file (run \`archon index\` to refresh)`);
      return;
    }

    const radius = seeds.length > 0 ? await new SymbolGraph(store).blastRadius(seeds) : { symbols: seeds, files: [] };
    const dependents = radius.symbols.filter((s) => !seeds.includes(s)).length;

    const files = store.allFileHashes();
    const model = store.loadModuleIntelligence() ?? inferBoundaries(files, store.loadFileEdges());
    const moduleName = moduleOf(target);
    const definedFiles = new Set(all.map((s) => s.file));
    const risk: FileRisk = scoreRisk({
      file: target,
      module: model.modules.find((m) => m.name === moduleName),
      blastRadius: dependents,
      confidence: moduleConfidence(moduleName, files, definedFiles),
    });

    if (opts.json) console.log(JSON.stringify(risk, null, 2));
    else console.log(formatRisk(risk));
  } finally {
    store.close();
  }
}

/**
 * Convention & philosophy profile (M11): the project's engineering culture
 * (typing strictness, abstraction tolerance, layering, stability bias, scale,
 * naming) inferred from the fingerprint + boundary model + scalar signals.
 * Read-only; derives from the existing index (run `archon index` first).
 */
export async function cmdPhilosophy(rt: Runtime, opts: { json?: boolean } = {}): Promise<void> {
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    if (opts.json) console.log(JSON.stringify(null));
    else console.log('philosophy: no index yet — run `archon index` first');
    return;
  }
  const store = new IndexStore(indexPath);
  try {
    const { fingerprint, model, files } = await fingerprintAndModel(rt.root, store);
    const profile = inferPhilosophy(fingerprint, model, await philosophySignals(rt.root, fingerprint, files));
    if (opts.json) console.log(JSON.stringify(profile, null, 2));
    else console.log(formatPhilosophy(profile));
  } finally {
    store.close();
  }
}

/**
 * Preservation assessment (M14): would a proposed change to `target` erase an
 * intentional / business-critical structure? Combines the file's risk + region
 * (M13), the project's philosophy (M11), and its module topology (M9) into a
 * preserve / caution / allow verdict. `change` defaults to `remove-abstraction`
 * (the generic rewrite preservation most needs to guard). Read-only, advisory.
 */
export async function cmdPreserve(
  rt: Runtime,
  target: string,
  change: ChangeKind = 'remove-abstraction',
  opts: { json?: boolean } = {},
): Promise<void> {
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    if (opts.json) console.log(JSON.stringify(null));
    else console.log('preserve: no index yet — run `archon index` first');
    return;
  }
  const store = new IndexStore(indexPath);
  try {
    const { fingerprint, model, files } = await fingerprintAndModel(rt.root, store);
    if (!files.some((f) => f.path === target)) {
      if (opts.json) console.log(JSON.stringify(null));
      else console.log(`preserve: "${target}" is not an indexed file (run \`archon index\` to refresh)`);
      return;
    }
    const all = store.allSymbols();
    const definedFiles = new Set(all.map((s) => s.file));
    const seeds = all.filter((s) => s.file === target).map((s) => s.name);
    const radius = seeds.length > 0 ? await new SymbolGraph(store).blastRadius(seeds) : { symbols: seeds, files: [] };
    const dependents = radius.symbols.filter((s) => !seeds.includes(s)).length;
    const moduleName = moduleOf(target);
    const moduleNode = model.modules.find((m) => m.name === moduleName);
    const risk = scoreRisk({
      file: target,
      module: moduleNode,
      blastRadius: dependents,
      confidence: moduleConfidence(moduleName, files, definedFiles),
    });
    const philosophy = inferPhilosophy(fingerprint, model, await philosophySignals(rt.root, fingerprint, files));
    const verdict = assessPreservation({
      target,
      module: moduleNode,
      risk,
      philosophy,
      change,
      isGodModule: model.godModules.some((g) => g.name === moduleName),
    });
    if (opts.json) console.log(JSON.stringify(verdict, null, 2));
    else console.log(formatPreservation(target, change, verdict));
  } finally {
    store.close();
  }
}

/**
 * Project-native agents (M18): generate the agent roster the detected stack +
 * topology + philosophy imply (routing, state, api-contract, architecture-review,
 * boundary-enforcer, dependency-cleanup, testing). Agents are derived, never
 * hand-coded. Read-only; derives from the existing index (run `archon index`).
 */
export async function cmdAgents(rt: Runtime, opts: { json?: boolean } = {}): Promise<void> {
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    if (opts.json) console.log(JSON.stringify([]));
    else console.log('agents: no index yet — run `archon index` then `archon init`');
    return;
  }
  const store = new IndexStore(indexPath);
  try {
    const agents = await agentRoster(rt, store);
    if (opts.json) console.log(JSON.stringify(agents, null, 2));
    else console.log(formatAgents(agents));
  } finally {
    store.close();
  }
}

/** Assemble the project-native agent roster from the index (shared by `agents` + `agent`). */
async function agentRoster(rt: Runtime, store: IndexStore): Promise<AgentSpec[]> {
  const { fingerprint, model, files } = await fingerprintAndModel(rt.root, store);
  const philosophy = inferPhilosophy(fingerprint, model, await philosophySignals(rt.root, fingerprint, files));
  return generateAgents(fingerprint, model, philosophy);
}

/**
 * Bind a project-native agent to a goal and drive it (M18 runtime). Selects the
 * agent whose scope/triggers best fit the goal, prepends its mandate (rules,
 * scope, capability ceiling) to the planner context, and either previews the
 * constrained plan (default) or runs it under a broker scoped to the agent's
 * declared capabilities (`--run`) — so the agent can never write more than its
 * spec allows. A read-only agent (e.g. architecture-review) can plan but its
 * writes are denied at the broker, so the run discards rather than merges.
 */
export async function cmdAgentRun(rt: Runtime, goal: string, opts: { run?: boolean } = {}): Promise<void> {
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    console.log('agent: no index yet — run `archon index` then `archon init`');
    return;
  }
  const store = new IndexStore(indexPath);
  let agent: AgentSpec | undefined;
  try {
    agent = selectAgent(await agentRoster(rt, store), goal);
  } finally {
    store.close();
  }
  if (!agent) {
    console.log('agent: none generated — run `archon index` then `archon init` first');
    return;
  }

  const task = makeTask(goal, 'trusted');
  const context = `${agentBriefing(agent)}\n\n${await planContext(rt, task, goal)}`;
  console.log(`agent: ${agent.id} (${agent.capabilities.join(', ')} · escalate ≥ ${agent.escalateAtRisk})`);
  if (!opts.run) {
    console.log(plannerLabel(rt.llmPlanning));
    printPlan(await rt.planner().plan(task, context));
    console.log(`  to execute under this agent: /agent --run ${goal}`);
    return;
  }
  console.log(`run ${task.id}: ${goal}`);
  printResults(await rt.loop(agent).run(task, context));
  console.log(`  replay: archon status ${task.id}`);
}

/**
 * Modules the Preservation Layer (M14) rules `preserve` against a generic
 * `simplify` — the set the improvement engine must not auto-propose changes to.
 * God modules are deliberately NOT protected (their complexity is accidental).
 */
function protectedModules(
  model: BoundaryModel,
  files: { path: string }[],
  definedFiles: Set<string>,
  philosophy: PhilosophyProfile,
): Set<string> {
  const godNames = new Set(model.godModules.map((g) => g.name));
  const result = new Set<string>();
  for (const m of model.modules) {
    const risk = scoreRisk({
      file: `${m.name}/index.ts`,
      module: m,
      blastRadius: m.fanIn,
      confidence: moduleConfidence(m.name, files, definedFiles),
    });
    const verdict = assessPreservation({
      target: m.name,
      module: m,
      risk,
      philosophy,
      change: 'simplify',
      isGodModule: godNames.has(m.name),
    });
    if (verdict.disposition === 'preserve') result.add(m.name);
  }
  return result;
}

/**
 * Conservative improvement proposals (M21): turn architecture-health findings
 * (M12) into ranked, ROI-gated remediation steps, never proposing a change to a
 * module the Preservation Layer (M14) protects. Read-only — it proposes; the
 * apply path is the cognition loop. Derives from the existing index.
 */
export async function cmdImprove(rt: Runtime, opts: { json?: boolean } = {}): Promise<void> {
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    if (opts.json) console.log(JSON.stringify({ proposals: [], skipped: [] }));
    else console.log('improve: no index yet — run `archon index` first');
    return;
  }
  const store = new IndexStore(indexPath);
  try {
    const { fingerprint, model, files } = await fingerprintAndModel(rt.root, store);
    const report = detectViolations(buildViolationInput(store));
    const philosophy = inferPhilosophy(fingerprint, model, await philosophySignals(rt.root, fingerprint, files));
    const definedFiles = new Set(store.allSymbols().map((s) => s.file));
    const protectedSubjects = protectedModules(model, files, definedFiles, philosophy);
    const improvements = proposeImprovements({ violations: report.violations, protectedSubjects });
    if (opts.json) console.log(JSON.stringify(improvements, null, 2));
    else console.log(formatImprovements(improvements));
  } finally {
    store.close();
  }
}

/** A proposal's remediation verb → the change kind the simulation evaluates it as. */
const CHANGE_BY_ACTION: Record<ImprovementAction, ChangeKind> = {
  'break-cycle': 'modify',
  decompose: 'extract', // decompose a god module by extracting cohesive submodules
  'realign-dependency': 'modify',
  'add-tests': 'modify',
};

const isSourceFile = (p: string): boolean => /\.[cm]?[jt]sx?$/.test(p) && !p.endsWith('.d.ts');

/**
 * Apply path for conservative evolution (M21 `refactor`): take the top-ranked
 * `improve` proposal (or `--pick N`), gate it through the M20 execution
 * simulation + M14 preservation, and — only if not blocked — execute it under the
 * best-fit, capability-scoped agent (M18). A `block` verdict refuses outright; a
 * `review` verdict needs an explicit `--force` (the human gate). The change runs
 * through the same worktree transaction as every other loop run, so a failing
 * verify discards it — nothing is applied blindly. Derives from the index.
 */
export async function cmdRefactor(rt: Runtime, opts: { pick?: number; force?: boolean } = {}): Promise<void> {
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    console.log('refactor: no index yet — run `archon index` first');
    return;
  }

  const { indexer, store, close } = await rt.indexer();
  let run: { agent: AgentSpec; goal: string } | undefined;
  try {
    const { fingerprint, model, files } = await fingerprintAndModel(rt.root, store);
    const philosophy = inferPhilosophy(fingerprint, model, await philosophySignals(rt.root, fingerprint, files));
    const definedFiles = new Set(store.allSymbols().map((s) => s.file));
    const protectedSubjects = protectedModules(model, files, definedFiles, philosophy);
    const { proposals } = proposeImprovements({
      violations: detectViolations(buildViolationInput(store)).violations,
      protectedSubjects,
    });
    if (proposals.length === 0) {
      console.log('refactor: nothing to refactor — architecture is clean (see `improve`)');
      return;
    }
    const idx = opts.pick ?? 0;
    const proposal = proposals[idx];
    if (!proposal) {
      console.log(`refactor: no proposal #${idx} — ${proposals.length} available (see \`improve\`)`);
      return;
    }

    // Resolve a representative source file in the proposal's subject module to simulate against.
    const subjectModule = proposal.subject.split(/ ↔ | → /)[0];
    const target = files.map((f) => f.path).find((p) => moduleOf(p) === subjectModule && isSourceFile(p));
    if (target === undefined) {
      console.log(`refactor: can't resolve a source file for "${proposal.subject}" — index may be stale`);
      return;
    }

    console.log(`refactor #${idx}: ${proposal.action} ${proposal.subject} (ROI ${proposal.roi})`);
    console.log(`  ${proposal.recommendation}`);

    // M20/M14 pre-apply gate — constrained autonomy: never apply a blocked change;
    // a `review` verdict needs an explicit --force.
    const sim = await assembleSimulation(rt.root, indexer, store, target, CHANGE_BY_ACTION[proposal.action]);
    if (sim) {
      console.log(
        `  simulate(${target}): ${sim.recommendation} · regression ${Math.round(sim.regression.probability * 100)}% · blast ${sim.propagation.files} file(s)`,
      );
      if (sim.recommendation === 'block') {
        console.log(`  BLOCKED — ${sim.rationale[0] ?? 'preservation / never-modify zone'}. Not applying.`);
        return;
      }
      if (sim.recommendation === 'review' && !opts.force) {
        console.log('  needs review — re-run `/refactor --force` to apply under the agent.');
        return;
      }
    }

    const agent = selectAgent(generateAgents(fingerprint, model, philosophy), `${proposal.action} ${proposal.subject} ${target}`);
    if (!agent) {
      console.log('refactor: no agent available to execute the change');
      return;
    }
    run = { agent, goal: `${proposal.recommendation} (target file: ${target})` };
  } finally {
    close();
  }
  if (!run) return; // an early branch above already reported why

  // Constrained execution under the capability-scoped agent, through the worktree
  // transaction (the index store is closed first to avoid a second open on it).
  const task = makeTask(run.goal, 'trusted');
  const context = `${agentBriefing(run.agent)}\n\n${await planContext(rt, task, run.goal)}`;
  console.log(`  agent: ${run.agent.id} (${run.agent.capabilities.join(', ')}) · ${plannerLabel(rt.llmPlanning)}`);
  console.log(`  run ${task.id}`);
  // `refactor` already ran the M14/M20 simulation gate at the command layer
  // (block refused, review needed --force), so the loop's own preservation gate
  // would be a redundant second block — pass force to defer to the command gate.
  printResults(await rt.loop(run.agent, { force: true }).run(task, context));
  console.log(`  replay: archon status ${task.id}`);
}

/**
 * Execution simulation (M20): predict the impact of a proposed change to `target`
 * BEFORE applying it — dependency propagation (blast radius), type-system + API-
 * contract drift surface, dependency-cycle state, a regression-probability
 * estimate, and an advisory autonomy verdict (auto / review / block). Composes
 * M9 boundaries + M13 risk + M14 preservation + M15 churn + the symbol graph.
 * `change` defaults to `modify`. Read-only and advisory — does not touch the
 * Policy Engine; derives from the existing index (run `archon index` first).
 */
export async function cmdSimulate(
  rt: Runtime,
  target: string,
  change: ChangeKind = 'modify',
  opts: { json?: boolean } = {},
): Promise<void> {
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    if (opts.json) console.log(JSON.stringify(null));
    else console.log('simulate: no index yet — run `archon index` first');
    return;
  }
  // Uses the full indexer (not a bare IndexStore) for `commitHistory()` — the M15
  // churn signal that feeds the regression estimate's volatility term.
  const { indexer, store, close } = await rt.indexer();
  try {
    const report = await assembleSimulation(rt.root, indexer, store, target, change);
    if (report === null) {
      if (opts.json) console.log(JSON.stringify(null));
      else console.log(`simulate: "${target}" is not an indexed file (run \`archon index\` to refresh)`);
      return;
    }
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatSimulation(report));
  } finally {
    close();
  }
}

/**
 * Hooks introspection (M19): the static pre-write gate (forbidden-import,
 * boundary-leak, never-modify) plus the post-write checks the detected stack
 * implies (typecheck, tests). With no pending change the pre-write gate reports
 * clean — the engine runs live before each loop write. Read-only.
 */
export async function cmdHooks(rt: Runtime, opts: { json?: boolean } = {}): Promise<void> {
  const indexPath = join(rt.root, rt.config.paths.index);
  let fingerprint: ArchitecturalFingerprint;
  if (existsSync(indexPath)) {
    const store = new IndexStore(indexPath);
    try {
      fingerprint = store.getFingerprint() ?? (await analyzeStructure(rt.root));
    } finally {
      store.close();
    }
  } else {
    fingerprint = await analyzeStructure(rt.root);
  }
  const findings = evaluatePreHooks({ writes: [], addedImports: [], existingEdges: [] });
  const post = postHookChecks(fingerprint);
  if (opts.json) console.log(JSON.stringify({ findings, post }, null, 2));
  else console.log(formatHooks(findings, post));
}

/**
 * Temporal evolution (M15): rank modules by churn × coupling over recent git
 * history and flag those trending toward god-object status. Read-only — reads
 * `git log` plus the existing index (run `archon index` first); the boundary
 * model comes from the persisted intelligence layer, falling back to a live
 * derivation.
 */
export async function cmdEvolution(rt: Runtime, opts: { json?: boolean } = {}): Promise<void> {
  const empty = (): EvolutionModel => ({ hotspots: [], godTrending: [], commitsAnalyzed: 0 });
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    if (opts.json) console.log(JSON.stringify(empty(), null, 2));
    else console.log('evolution: no index yet — run `archon index` first');
    return;
  }
  const { indexer, store, close } = await rt.indexer();
  try {
    const model = store.loadModuleIntelligence() ?? inferBoundaries(store.allFileHashes(), store.loadFileEdges());
    const evo = analyzeEvolution(await indexer.commitHistory(), model);
    if (opts.json) console.log(JSON.stringify(evo, null, 2));
    else console.log(formatEvolution(evo));
  } finally {
    close();
  }
}

/**
 * Decision intelligence (M16): query the repo's ADRs as decision memory, or
 * `propose` a draft ADR for the latest significant change. With no argument it
 * lists every recorded decision; `<query>` filters by substring; `propose`
 * drafts (never files) an ADR for a human to complete. Read-only — ADRs are read
 * from `docs/adr/`; `init` is what ingests them into recallable semantic memory.
 */
export async function cmdDecisions(rt: Runtime, arg?: string): Promise<void> {
  if (arg === 'propose') return cmdAdrPropose(rt);
  const decisions = await loadDecisions(rt.root);
  const filtered = arg ? decisions.filter((d) => matchesQuery(d, arg)) : decisions;
  console.log(formatDecisions(filtered, arg));
}

/** Parse every numbered ADR under `docs/adr/`, ordered by id. Empty when none exist. */
async function loadDecisions(root: string): Promise<Decision[]> {
  const adrDir = join(root, 'docs', 'adr');
  if (!existsSync(adrDir)) return [];
  const files = (await readdir(adrDir)).filter((f) => /^\d{1,4}.*\.md$/.test(f)).sort();
  const decisions = await Promise.all(
    files.map(async (f) => parseAdr(await readFile(join(adrDir, f), 'utf8'), posix.join('docs/adr', f))),
  );
  return decisions;
}

/**
 * Propose a draft ADR for the latest commit when it is significant (touches a
 * load-bearing module or is broad). Emits a `proposed`-status template to stdout
 * for a human to complete and file — it never writes an ADR (the proposed →
 * accepted gate stays human). Read-only; needs an index for module criticality.
 */
async function cmdAdrPropose(rt: Runtime): Promise<void> {
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    console.log('decisions: no index yet — run `archon index` first');
    return;
  }
  const { indexer, store, close } = await rt.indexer();
  try {
    const [latest] = await indexer.commitHistory(1);
    if (!latest) {
      console.log('decisions: no commits to assess');
      return;
    }
    const model = store.loadModuleIntelligence() ?? inferBoundaries(store.allFileHashes(), store.loadFileEdges());
    const sig = assessSignificance(latest, model);
    if (!sig.significant) {
      console.log(`decisions: latest change (${latest.hash.slice(0, 8)}) is ${sig.reason} — no ADR proposed`);
      return;
    }
    const decisions = await loadDecisions(rt.root);
    const maxId = decisions.reduce((m, d) => Math.max(m, Number(d.id) || 0), 0);
    const nextId = String(maxId + 1).padStart(4, '0');
    console.log(`decisions: latest change is significant (${sig.reason}) — proposed ADR draft:\n`);
    console.log(proposeAdr(nextId, latest, sig, new Date().toISOString().slice(0, 10)));
  } finally {
    close();
  }
}

/** Assemble the violation detector's inputs from an open index store. */
function buildViolationInput(store: IndexStore): Parameters<typeof detectViolations>[0] {
  const files = store.allFileHashes();
  const edges = store.loadFileEdges();
  const model = store.loadModuleIntelligence() ?? inferBoundaries(files, edges);
  return { model, files, edges, definedFiles: new Set(store.allSymbols().map((s) => s.file)) };
}

type IndexedSymbol = { name: string; file: string; kind: string };

/**
 * Resolve a query to a single indexed symbol: a fully-qualified id matches
 * directly, else a bare name (`foo`) matches by the segment after '#', which may
 * collide across files. Returns the match, or the colliding candidates so the
 * caller can ask the operator to qualify.
 */
function resolveSymbol(all: IndexedSymbol[], query: string): { match?: IndexedSymbol; candidates: string[] } {
  const exact = all.find((s) => s.name === query);
  if (exact) return { match: exact, candidates: [] };
  const matches = all.filter((s) => bareName(s.name) === query);
  if (matches.length === 1) return { match: matches[0], candidates: [] };
  return { candidates: matches.map((m) => m.name) };
}

const unresolvedMsg = (label: string, query: string, candidates: string[]): string =>
  candidates.length > 0
    ? `path: ${label} "${query}" is ambiguous — qualify one of: ${candidates.join(', ')}`
    : `path: ${label} "${query}" is not an indexed symbol`;

/**
 * Trace the shortest dependency chain from one symbol to another: "how does A
 * reach B?" Follows dependency edges (A → … → B means A transitively depends on
 * B), the trace complement to `impact`'s reverse set. Both endpoints accept a
 * qualified id or a bare name (ambiguity is reported). Read-only and WASM-free.
 */
export async function cmdPath(rt: Runtime, from: string, to: string): Promise<void> {
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) {
    console.log('path: no index yet — run `archon index` first');
    return;
  }
  const store = new IndexStore(indexPath);
  try {
    const all = store.allSymbols();
    const a = resolveSymbol(all, from);
    if (!a.match) {
      console.log(unresolvedMsg('from', from, a.candidates));
      return;
    }
    const b = resolveSymbol(all, to);
    if (!b.match) {
      console.log(unresolvedMsg('to', to, b.candidates));
      return;
    }
    const chain = new SymbolGraph(store).path(a.match.name, b.match.name);
    if (!chain) {
      console.log(`path: ${a.match.name} does not transitively depend on ${b.match.name} (no path)`);
      return;
    }
    console.log(`path: ${a.match.name} depends on ${b.match.name} via ${chain.length - 1} hop(s):`);
    console.log(`  ${chain.join(' → ')}`);
  } finally {
    store.close();
  }
}

/** Machine-readable shape of `archon status --json` (a stable automation contract). */
export interface StatusReport {
  profile: Profile;
  budgets: { perTaskUsd: number; globalDailyUsd: number; contextTokensMax: number };
  journal: { seq: number; ts: string; taskId: string; kind: string }[];
}

export async function cmdStatus(rt: Runtime, opts: { json?: boolean; taskId?: string } = {}): Promise<void> {
  const b = rt.config.budgets;
  // Read-only intent: don't create the db just to report an empty journal, so
  // open the real path only when it already exists (else an ephemeral one).
  const journalPath = join(rt.root, rt.config.paths.journal);
  const journal = new TaskJournal(existsSync(journalPath) ? journalPath : ':memory:');
  try {
    // Drill into one run: its full append-ordered stream (plan → steps → diffs →
    // verdict → decision → cost), the same record used for crash-resume.
    if (opts.taskId) {
      const entries = await journal.replay(opts.taskId);
      if (opts.json) {
        console.log(JSON.stringify({ taskId: opts.taskId, entries }, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log(`task ${opts.taskId}: no journal entries (unknown task id — see \`archon status\`)`);
        return;
      }
      console.log(`task ${opts.taskId}: ${entries.length} entries (in order):`);
      for (const e of entries) console.log(`  #${e.seq} ${e.kind.padEnd(8)} ${journalDetail(e)}`);
      return;
    }
    const recent = journal.recent(15);
    if (opts.json) {
      const report: StatusReport = {
        profile: rt.config.profile,
        budgets: { perTaskUsd: b.perTaskUsd, globalDailyUsd: b.globalDailyUsd, contextTokensMax: b.contextTokensMax },
        journal: recent.map((e) => ({ seq: e.seq, ts: e.ts, taskId: e.taskId, kind: e.kind })),
      };
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `profile: ${rt.config.profile}   budgets: $${b.perTaskUsd}/task · $${b.globalDailyUsd}/day · ${b.contextTokensMax} ctx-tok`,
    );
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

/**
 * Recap: a per-run digest of Archon's recent activity (from the task journal) +
 * the latest architecture-health reading and its trend. Read-only — opens the
 * journal and index only when they already exist (never creates them), like
 * `status`/`doctor`. `--json` emits the `RecapModel` for piping.
 */
export async function cmdRecap(rt: Runtime, opts: { json?: boolean } = {}): Promise<void> {
  const journalPath = join(rt.root, rt.config.paths.journal);
  const indexPath = join(rt.root, rt.config.paths.index);
  const journal = new TaskJournal(existsSync(journalPath) ? journalPath : ':memory:');
  // Health history lives in the index store; absent ⇒ no trend (recap still
  // works off the journal alone). Guarded so a recap creates no db.
  const store = existsSync(indexPath) ? new IndexStore(indexPath) : undefined;
  try {
    // Scan a generous window so multi-entry runs are reconstructed whole; the
    // formatter caps how many runs are listed.
    const model = recap(journal.recent(200), store?.loadHealthHistory() ?? []);
    if (opts.json) console.log(JSON.stringify(model, null, 2));
    else console.log(formatRecap(model));
  } finally {
    journal.close();
    store?.close();
  }
}

/**
 * Session spend so far against the per-task budget that arms the router's
 * circuit-breaker. Shell-only: the one-shot CLI builds a fresh runtime per
 * command (spend always zero), so this is meaningful only across a REPL session
 * where the router — and its running tally — persists.
 */
export function cmdCost(rt: Runtime): void {
  const spent = rt.router.spent;
  const b = rt.config.budgets;
  const pct = b.perTaskUsd > 0 ? Math.min(100, Math.round((spent / b.perTaskUsd) * 100)) : 0;
  console.log(`cost: $${spent.toFixed(4)} this session`);
  console.log(`  budgets: $${b.perTaskUsd}/task · $${b.globalDailyUsd}/day  (task budget ${pct}% used)`);
  if (spent >= b.perTaskUsd) console.log('  ⚠ per-task budget reached — the router will refuse further calls');
}

/**
 * Show the provider routing table: every configured model (provider, strengths,
 * indicative per-1k cost, and whether a client is wired) and, per task class, the
 * resolved model chain — first entry is the one that will be chosen. Also lists
 * any provider-plugin fallbacks (tried when no model serves a request, ADR-0012).
 * Read-only; `✓` = a client backs it, `○` = configured but no key, so it can't run.
 */
export async function cmdModel(rt: Runtime): Promise<void> {
  const { models, routes } = rt.router.routingTable();
  const fallback = await rt.router.fallbackProviders();
  if (models.length === 0 && fallback.length === 0) {
    console.log('model: none configured — add providers to archon.config.json (see `archon doctor`)');
    return;
  }
  if (models.length > 0) {
    console.log(`models (${models.length} configured):`);
    for (const m of models) {
      const cost = `$${m.costPer1kInput}/$${m.costPer1kOutput} per 1k`;
      const note = m.ready ? '' : '  (no client — key missing)';
      console.log(`  ${m.ready ? '✓' : '○'} ${m.id}  [${m.provider}]  {${m.strengths.join(' ')}}  ${cost}${note}`);
    }
    console.log('routing (task class → model chain, first is chosen):');
    const known = new Set(models.map((m) => m.id));
    let dangling = false;
    for (const r of routes) {
      const chain = r.chain.map((id) => {
        if (known.has(id)) return id;
        dangling = true;
        return `${id}(?)`; // configured in routing but absent from the registry
      });
      console.log(`  ${r.taskClass.padEnd(10)} ${chain.length ? chain.join(' → ') : '(none)'}`);
    }
    if (dangling) console.log('  (? = configured in routing but not in the model registry — skipped at run time)');
  }
  if (fallback.length > 0) {
    console.log(`fallback providers (plugins, tried when no model serves): ${fallback.join(', ')}`);
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

/** List records that meet the promotion bar (frequency + success), pending confirmation. */
export async function cmdPromotions(rt: Runtime): Promise<void> {
  if (!existsSync(join(rt.root, rt.config.paths.memory))) {
    console.log('memory: empty (no runs yet)');
    return;
  }
  const candidates = await new PromotionEngine(rt.memory()).propose();
  if (candidates.length === 0) {
    console.log('memory: no records meet the promotion bar (freq ≥ 3 + success ≥ 2)');
    return;
  }
  console.log(`memory: ${candidates.length} promotion candidate(s) — confirm with \`memory promote <id>\`:`);
  for (const c of candidates) console.log(`  ${c.id}  [${c.tier} ↑]  ${c.key}`);
}

const MEMORY_TIERS: MemoryTier[] = ['episodic', 'semantic', 'procedural'];
const isMemoryTier = (s: string): s is MemoryTier => (MEMORY_TIERS as string[]).includes(s);

/**
 * Inspect what memory holds — the stored records, optionally narrowed to one
 * tier (episodic → semantic → procedural), pinned (ADRs) first. This makes the
 * memory plane observable the way `policy` does for the safety plane: you can see
 * what was learned and which records are confirmed, not just recall by goal.
 * Read-only — guarded on the db's existence so it never creates an empty store.
 */
export async function cmdMemoryList(rt: Runtime, tier?: string): Promise<void> {
  if (!existsSync(join(rt.root, rt.config.paths.memory))) {
    console.log('memory: empty (no runs yet)');
    return;
  }
  if (tier !== undefined && !isMemoryTier(tier)) {
    console.log(`memory: unknown tier "${tier}" — use one of: ${MEMORY_TIERS.join(', ')}`);
    return;
  }
  const records = rt.memory().list(tier);
  if (records.length === 0) {
    console.log(tier ? `memory: no records in the ${tier} tier` : 'memory: no records stored yet');
    return;
  }
  console.log(`memory: ${records.length} record(s)${tier ? ` in ${tier}` : ''} (pinned/most-used first):`);
  for (const r of records) {
    const flag = r.confirmed ? ' ✓confirmed' : '';
    const preview = r.content.replace(/\s+/g, ' ').trim().slice(0, 60);
    console.log(`  [${r.tier.padEnd(10)}] ${r.key}${flag}  ${preview}`);
  }
}

/** The human gate: confirm a candidate, moving it one tier up (episodic → semantic → procedural). */
export async function cmdPromote(rt: Runtime, id: string): Promise<void> {
  const tier = await new PromotionEngine(rt.memory()).confirm(id);
  console.log(
    tier
      ? `memory: promoted ${id} → ${tier}`
      : `memory: "${id}" is not promotable (unknown id or already at the top tier)`,
  );
}

/**
 * Readiness report: planner choice, configured providers + whether each key is
 * present (never the key itself), budgets, which `.archon/*.db` exist, and how
 * many plugins are loaded. Strictly read-only — it creates no db (existence is
 * probed, not opened), so running `doctor` never changes the repo.
 */
/** Machine-readable shape of `archon doctor --json` (a stable automation contract). */
export interface DoctorReport {
  root: string;
  node: string;
  profile: Profile;
  planner: 'llm' | 'deterministic';
  providers: { id: string; supported: boolean; keyPresent: boolean }[];
  budgets: { perTaskUsd: number; globalDailyUsd: number; contextTokensMax: number };
  state: { index: boolean; memory: boolean; journal: boolean };
  plugins: number;
  /** Architecture health (M12) + its trend over recorded scans (M15), or null when there is no index. */
  health: { score: number; high: number; medium: number; low: number; trend: number | null } | null;
  /** Temporal evolution forecast (M15), or null when there is no index. */
  evolution: { commitsAnalyzed: number; godTrending: number; topHotspot: string | null } | null;
}

export async function cmdDoctor(rt: Runtime, opts: { json?: boolean } = {}): Promise<void> {
  const { config } = rt;
  const present = (rel: string): boolean => existsSync(join(rt.root, rel));
  const arch = await assessArchitecture(rt);
  const report: DoctorReport = {
    root: rt.root,
    node: process.version,
    profile: config.profile,
    planner: rt.llmPlanning ? 'llm' : 'deterministic',
    providers: rt.providerStatus,
    budgets: {
      perTaskUsd: config.budgets.perTaskUsd,
      globalDailyUsd: config.budgets.globalDailyUsd,
      contextTokensMax: config.budgets.contextTokensMax,
    },
    state: {
      index: present(config.paths.index),
      memory: present(config.paths.memory),
      journal: present(config.paths.journal),
    },
    plugins: (await rt.pluginHost()).list().length,
    health: arch.health,
    evolution: arch.evolution,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`archon doctor — ${report.root}`);
  console.log(`  node:      ${report.node}`);
  console.log(`  profile:   ${report.profile}`);
  console.log(`  planner:   ${report.planner === 'llm' ? 'llm (provider-router)' : 'deterministic (scaffold)'}`);

  if (report.providers.length === 0) {
    console.log('  providers: none configured → offline scaffold planner');
  } else {
    console.log('  providers:');
    for (const p of report.providers) {
      const state = !p.supported ? 'unsupported (no client yet)' : p.keyPresent ? 'key present' : 'key missing';
      console.log(`    - ${p.id}: ${state}`);
    }
  }

  const b = report.budgets;
  console.log(`  budgets:   $${b.perTaskUsd}/task · $${b.globalDailyUsd}/day · ${b.contextTokensMax} ctx-tok`);

  const mark = (ok: boolean): string => (ok ? 'present' : 'absent');
  console.log('  state:');
  console.log(`    - index:   ${mark(report.state.index)}`);
  console.log(`    - memory:  ${mark(report.state.memory)}`);
  console.log(`    - journal: ${mark(report.state.journal)}`);

  console.log(`  plugins:   ${report.plugins} loaded`);

  if (report.health === null) {
    console.log('  health:    no index — run `archon index` for an architecture-health score');
  } else {
    const h = report.health;
    const trend = h.trend === null ? '' : `  trend ${trendArrow(h.trend)} ${h.trend >= 0 ? '+' : ''}${h.trend} over last 2 scans`;
    console.log(`  health:    ${h.score}/100  (${h.high} high · ${h.medium} medium · ${h.low} low)${trend} — see \`archon violations\``);
  }

  if (report.evolution !== null && report.evolution.commitsAnalyzed > 0) {
    const e = report.evolution;
    const summary = e.godTrending === 0 ? 'none' : `${e.godTrending} (top: ${e.topHotspot}) — see \`archon evolution\``;
    console.log(`  evolution: ${e.commitsAnalyzed} commits · trending toward god-object: ${summary}`);
  }
}

/** ▲ rising health, ▼ falling, ▶ flat — for the doctor trend line. */
const trendArrow = (delta: number): string => (delta > 0 ? '▲' : delta < 0 ? '▼' : '▶');

/**
 * Architecture health + temporal evolution from the index (M12 + M15), or
 * null/null when no index exists yet. Reads `git log` for churn; shares one
 * open store so doctor opens the index once.
 */
async function assessArchitecture(
  rt: Runtime,
): Promise<{ health: DoctorReport['health']; evolution: DoctorReport['evolution'] }> {
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) return { health: null, evolution: null };
  const { indexer, store, close } = await rt.indexer();
  try {
    const { healthScore, countsBySeverity } = detectViolations(buildViolationInput(store));
    const history = store.loadHealthHistory();
    const trend =
      history.length >= 2 ? history[history.length - 1].score - history[history.length - 2].score : null;

    const model = store.loadModuleIntelligence() ?? inferBoundaries(store.allFileHashes(), store.loadFileEdges());
    const evo = analyzeEvolution(await indexer.commitHistory(), model);
    return {
      health: { score: healthScore, ...countsBySeverity, trend },
      evolution: {
        commitsAnalyzed: evo.commitsAnalyzed,
        godTrending: evo.godTrending.length,
        topHotspot: evo.godTrending[0]?.name ?? null,
      },
    };
  } finally {
    close();
  }
}

/**
 * List plugins loaded from `.archon/plugins/`, previewing each declared
 * capability against the active policy. The same gate runs at invoke time, so a
 * `⚠` plugin (any capability not `allow`ed) won't run cleanly under this profile.
 */
export async function cmdPlugins(rt: Runtime): Promise<void> {
  const plugins = (await rt.pluginHost()).list();
  if (plugins.length === 0) {
    console.log('plugins: none loaded — drop one at .archon/plugins/<name>/plugin.mjs');
    return;
  }
  const engine = rt.policy();
  console.log(`plugins: ${plugins.length} loaded (profile: ${rt.config.profile}):`);
  for (const { manifest } of plugins) {
    const decisions = manifest.capabilities.map((action) => ({
      action,
      decision: engine.evaluate({ action, target: `plugin:${manifest.name}`, reason: 'capability preview' }).decision,
    }));
    const runnable = decisions.every((d) => d.decision === 'allow');
    const caps = decisions.length ? decisions.map((d) => `${d.action}=${d.decision}`).join(', ') : '(no capabilities)';
    console.log(`  ${runnable ? '✓' : '⚠'} ${manifest.name}@${manifest.version}  [${manifest.kind}]  ${caps}`);
  }
}

/**
 * List loaded `skill`-kind plugins, or print one skill's full playbook by name.
 * A skill is a reusable procedural playbook (Markdown) the planner can follow;
 * this is the discovery surface for the 5th ABI kind. Strictly read-only —
 * printing a playbook exercises no capability, so (like `archon plugins`) it
 * needs no broker gate. See ADR-0009.
 */
export async function cmdSkills(rt: Runtime, name?: string): Promise<void> {
  const skills = (await rt.pluginHost()).list().filter((p): p is SkillPlugin => p.kind === 'skill');
  if (skills.length === 0) {
    console.log('skills: none loaded — drop one at .archon/plugins/<name>/plugin.mjs (kind: "skill")');
    return;
  }
  if (name) {
    const skill = skills.find((s) => s.manifest.name === name);
    if (!skill) {
      console.log(`skills: no skill "${name}" — loaded: ${skills.map((s) => s.manifest.name).join(', ')}`);
      return;
    }
    console.log(`# skill: ${skill.manifest.name}@${skill.manifest.version}\n`);
    console.log(skill.playbook);
    return;
  }
  console.log(`skills: ${skills.length} loaded — \`archon skills <name>\` to view a playbook:`);
  for (const { manifest, playbook } of skills) {
    const summary = playbook.split('\n').find((l) => l.trim())?.trim() ?? '(empty playbook)';
    console.log(`  - ${manifest.name}@${manifest.version}  ${summary.slice(0, 60)}`);
  }
}

/**
 * Run a command from the shell THROUGH the Capability Broker, so the active
 * policy decides: dev commands (`npm`, `node`, `tsc`, `git status`/`diff`/`add`/
 * `commit`) run under `safe`; risky ones (`git checkout`/`merge`) are refused as
 * `ask`; destructive ones (`rm -rf`, `git push --force`) are denied. There is no
 * OS shell — the line is split into argv and handed to `execFile`, so no
 * pipes/redirects/globs and no shell-injection surface. This puts the very gate
 * the agent obeys at the operator's fingertips. See ADR-0003.
 */
export async function cmdSh(rt: Runtime, command: string): Promise<void> {
  const argv = command.split(/\s+/).filter(Boolean);
  if (argv.length === 0) {
    console.log('usage: /sh <command> [args…]  (policy-gated; no shell — argv only)');
    return;
  }
  const res = await rt.brokerAt(rt.root).exec(argv, { reason: 'interactive /sh' });
  if (!res.ok) {
    // policy.deny / policy.ask (refused before running) or exec.failed (ran, exited non-zero)
    console.error(`  ✗ ${res.error.code}: ${res.error.message}`);
    return;
  }
  if (res.value.stdout) process.stdout.write(res.value.stdout);
  if (res.value.stderr) process.stderr.write(res.value.stderr);
  if (!res.value.stdout && !res.value.stderr) console.log('  ✓ ok (no output)');
}

/** Decision glyph: ✓ allow · ? ask · ✗ deny — the same vocabulary across the gate's surfaces. */
const decisionGlyph = (d: PolicyDecision): string => (d === 'allow' ? '✓' : d === 'ask' ? '?' : '✗');

/**
 * Make the safety layer observable. With no argument: the active profile, its
 * inheritance chain, and every allow/ask/deny rule in effect — the constraint
 * surface the agent runs under, including the destructive `deny`s and secret-read
 * blocks. With `check <command>`: dry-run that command through the very gate the
 * broker uses, printing the decision and the rule that fired, WITHOUT executing it
 * — the non-running twin of `/sh`. Strictly read-only (no broker, no effect). See
 * ADR-0003.
 */
export async function cmdPolicy(rt: Runtime, opts: { check?: string; json?: boolean } = {}): Promise<void> {
  const engine = rt.policy();
  if (opts.check !== undefined) {
    const command = opts.check.trim();
    if (!command) {
      if (!opts.json) console.log('usage: policy check <command>  (dry-run — does not execute)');
      return;
    }
    // The verdict IS the contract — { decision, rule, message } — so an agent can
    // gate an action with `archon policy check --json '<cmd>' | jq .decision`.
    const v = engine.evaluate({ action: 'exec', target: command, reason: 'policy check (dry-run)' });
    if (opts.json) {
      console.log(JSON.stringify(v, null, 2));
      return;
    }
    console.log(`${decisionGlyph(v.decision)} ${v.decision}: ${command}`);
    console.log(`  rule: ${v.rule}`);
    if (v.decision !== 'allow') console.log(`  ${v.message}`);
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(engine.describe(), null, 2));
    return;
  }
  const { profile, chain, rules } = engine.describe();
  const inherits = chain.length > 1 ? ` (inherits ${chain.slice(1).join(' → ')})` : '';
  console.log(`policy: profile "${profile}"${inherits}`);
  if (rules.length === 0) {
    console.log('  (no rules — everything is default-denied)');
    return;
  }
  for (const r of rules) {
    const cond = r.conditional ? '  (conditional)' : '';
    console.log(`  ${decisionGlyph(r.decision)} ${r.decision.padEnd(5)} ${r.action.padEnd(11)} ${r.target}${cond}`);
  }
  console.log('  (deny > ask > allow; anything unmatched is denied)');
}

/**
 * Invoke a loaded `tool` plugin by name; the optional argument is JSON parsed
 * into the tool input. The host enforces the plugin's declared capabilities
 * against the active policy *before* it runs, so a tool wanting a capability the
 * profile won't grant is refused (e.g. `policy.ask` on `net` under `safe`), not
 * executed — the load → list → invoke loop with the broker in the middle.
 */
export async function cmdTool(rt: Runtime, name: string, inputJson?: string): Promise<void> {
  let input: unknown;
  if (inputJson) {
    try {
      input = JSON.parse(inputJson);
    } catch {
      console.log(`tool ${name}: input is not valid JSON: ${inputJson}`);
      return;
    }
  }
  const result = await (await rt.pluginHost()).invokeTool(name, input);
  console.log(
    result.ok
      ? `tool ${name}: ${JSON.stringify(result.value)}`
      : `tool ${name}: refused (${result.error.code}) ${result.error.message}`,
  );
}
