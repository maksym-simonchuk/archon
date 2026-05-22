// Shared command implementations + formatters used by both the one-shot CLI
// (src/cli.ts) and the interactive shell (src/shell.ts). Each command takes an
// already-built Runtime and does NOT own its lifecycle — the caller closes it.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CognitivePlan } from './cognition/types';
import type { JournalEntry, Profile, StepResult, Task } from './core/types';
import { PromotionEngine } from './memory/promotion';
import type { SkillPlugin } from './plugins/abi';
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

export async function cmdRun(rt: Runtime, goal: string, opts: { skill?: string } = {}): Promise<void> {
  console.log(plannerLabel(rt.llmPlanning));
  const task = makeTask(goal, 'trusted');
  // Print the id before running so it's known even if the loop throws mid-run —
  // the partial journal is still inspectable via `archon status <id>`.
  console.log(`run ${task.id}: ${goal}`);
  printResults(await rt.loop().run(task, await planContext(rt, task, goal, opts.skill)));
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
}

export async function cmdDoctor(rt: Runtime, opts: { json?: boolean } = {}): Promise<void> {
  const { config } = rt;
  const present = (rel: string): boolean => existsSync(join(rt.root, rel));
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
