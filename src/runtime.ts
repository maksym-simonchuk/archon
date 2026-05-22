import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentSpec } from './cognition/agent-factory';
import { CognitionLoop } from './cognition/loop';
import type { ChangeKind } from './cognition/preservation';
import { assembleSimulation } from './simulation-assembly';
import { Executor } from './cognition/executor';
import { Planner } from './cognition/planner';
import { ProviderPlanner } from './cognition/provider-planner';
import { Reflector } from './cognition/reflector';
import { ScaffoldStrategy } from './cognition/scaffold-strategy';
import type { PlanStrategy } from './cognition/types';
import { Verifier } from './cognition/verifier';
import { loadComputeCore, type ComputeCore } from './core/compute';
import type { BlastRadius, MemoryTier, Profile, Task } from './core/types';
import { AgentBroker } from './effecting/agent-broker';
import { AuditLog } from './effecting/audit-log';
import { CapabilityBroker } from './effecting/capability-broker';
import { loadPolicy, PolicyEngine, type PolicyDocument } from './effecting/policy-engine';
import { evaluatePreHooks, type PreHookFinding } from './effecting/hooks';
import { Transaction } from './effecting/transaction';
import { MemoryStore } from './memory/store';
import { embedText } from './memory/vector-index';
import { createPersistedRetriever } from './plugins/builtin/persisted-retriever';
import type { RetrieverPlugin } from './plugins/abi';
import { decomposeIntent } from './sensing/context-scope';
import { ContextService } from './sensing/context-service';
import { extractImports, resolveImport } from './sensing/import-resolver';
import { Indexer } from './sensing/indexer';
import { IndexStore } from './sensing/store';
import { parseTsSymbols } from './sensing/ts-parser';
import { SymbolGraph } from './sensing/symbol-graph';
import { loadConfig, type ArchonConfig } from './services/config';
import { createAiClient } from './services/providers/ai-sdk';
import { resolveModels } from './services/model-catalog';
import { PluginHost } from './services/plugin-host';
import { ProviderRouter, type ProviderClient } from './services/provider-router';
import { TaskJournal } from './services/task-journal';

/** Maps a key-bearing provider id to the env var holding its API key — single source of truth. */
const PROVIDER_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

/** Providers that need no API key (a local OpenAI-compatible server reached by base URL). */
const KEYLESS_PROVIDERS = new Set(['local']);
/** Default endpoint for the `local` provider (ollama); overridable via env. */
const LOCAL_BASE_URL = process.env.ARCHON_LOCAL_BASE_URL ?? 'http://localhost:11434/v1';

/** True if Archon ships a client builder for this provider id (with or without a key). */
const isSupportedProvider = (id: string): boolean => PROVIDER_ENV[id] !== undefined || KEYLESS_PROVIDERS.has(id);

/** The provider's API key from the environment, or undefined if unset/unknown. */
function envKey(id: string): string | undefined {
  const name = PROVIDER_ENV[id];
  return name ? process.env[name] : undefined;
}

/** Build the concrete provider clients available in this environment (keyed providers need their key). */
function buildClients(providers: { id: string }[]): ProviderClient[] {
  const clients: ProviderClient[] = [];
  for (const p of providers) {
    if (p.id === 'anthropic' || p.id === 'openai' || p.id === 'google') {
      const key = envKey(p.id);
      if (key) clients.push(createAiClient(p.id, key));
    } else if (p.id === 'local') {
      // No key needed; point the OpenAI-compatible client at the local server.
      clients.push(createAiClient('local', process.env.ARCHON_LOCAL_API_KEY ?? 'local', { baseURL: LOCAL_BASE_URL }));
    }
  }
  return clients;
}

/**
 * The composed Archon runtime. Pure wiring (router, planner strategy, broker
 * factory, plugin host) is built eagerly; db-backed resources (memory, journal,
 * index) and the WASM core are opened lazily so read-only commands like `plan`
 * and `status` never create `.archon/*.db`. The caller owns the lifecycle: call
 * `close()` when done.
 */
export interface Runtime {
  readonly config: ArchonConfig;
  readonly root: string;
  readonly router: ProviderRouter;
  /** True when an LLM-backed planner is active (a provider key was found). */
  readonly llmPlanning: boolean;
  /** Configured providers: whether a client-builder exists (`supported`) and whether its key is in the env (key value never exposed). */
  readonly providerStatus: { id: string; supported: boolean; keyPresent: boolean }[];
  /** Planner using the chosen strategy (ProviderPlanner, else ScaffoldStrategy). */
  planner(): Planner;
  /** Assemble the budgeted repo-map context for a task (empty for the offline planner). */
  context(task: Task): Promise<string>;
  /** Broker rooted at `cwd`; profile defaults to the config profile. */
  brokerAt(cwd: string, profile?: Profile): CapabilityBroker;
  /** The shared (lazily-opened) memory store. */
  memory(): MemoryStore;
  /** The shared (lazily-opened) task journal. */
  journal(): TaskJournal;
  /**
   * Full plan → act → verify → reflect loop, sharing this runtime's memory +
   * journal. With an `agent`, the executor's writes are scoped to that agent's
   * declared capabilities (M18) — it can never write more than its spec allows.
   * `force` overrides the M14/M20 preservation pre-apply block (a structure-
   * stripping change to an intentional/critical module); never-modify zones and
   * import cycles (M19) still hard-block regardless. Tighten-never-widen holds.
   */
  loop(agent?: AgentSpec, opts?: { force?: boolean }): CognitionLoop;
  /** A built-in embedding retriever over one memory anchor, registered with the host. */
  retriever(tier: MemoryTier, key: string): Promise<RetrieverPlugin>;
  /** An incremental indexer plus its index store (caller closes the returned store). */
  indexer(): Promise<{ indexer: Indexer; store: IndexStore; close(): void }>;
  /** The live plugin host: external plugins from `.archon/plugins/` loaded once (memoized). */
  pluginHost(): Promise<PluginHost>;
  /** A PolicyEngine for `profile` (defaults to the config profile) — pure capability previews, no audit. */
  policy(profile?: Profile): PolicyEngine;
  /** Close every resource this runtime opened (memory, journal). */
  close(): void;
}

/**
 * Composition root: load config + policy, choose the planner strategy from the
 * provider registry and environment, and wire every plane into one `Runtime`.
 * This is the single place that decides "LLM planner vs deterministic
 * scaffolder" — when a provider is configured and its key is in the environment
 * the router-backed `ProviderPlanner` is used, otherwise the offline
 * `ScaffoldStrategy`. Either way the produced plan is executed through the same
 * broker-gated loop, so the planner is never trusted with authority.
 */
export async function buildRuntime(root: string): Promise<Runtime> {
  const config = await loadConfig(root);
  const policyDoc: PolicyDocument = loadPolicy(await readFile(join(root, config.paths.policy), 'utf8'));
  const audit = new AuditLog();

  const models = resolveModels(config.providers);
  const clients = buildClients(config.providers);
  const router = new ProviderRouter(models, clients, {
    routing: config.routing,
    fallback: config.routing.fallback,
    budgetUsd: config.budgets.perTaskUsd,
    // Lazy: the host (and its `.archon/plugins/` imports) load only if the
    // router ever needs a fallback. `pluginHost` is defined below — the closure
    // captures it and is never called before buildRuntime returns. See ADR-0012.
    providerPlugins: async () => (await pluginHost()).providerPlugins(),
  });

  const llmPlanning = models.length > 0 && clients.length > 0;
  const strategy: PlanStrategy = llmPlanning ? new ProviderPlanner(router) : new ScaffoldStrategy();
  const providerStatus = config.providers.map((p) => ({
    id: p.id,
    supported: isSupportedProvider(p.id),
    // Keyless providers (local) are "ready" without a key; keyed ones need theirs in env.
    keyPresent: KEYLESS_PROVIDERS.has(p.id) ? true : Boolean(envKey(p.id)),
  }));

  const brokerAt = (cwd: string, profile: Profile = config.profile): CapabilityBroker =>
    new CapabilityBroker(new PolicyEngine(policyDoc, profile), audit, cwd);

  // A trusted broker narrowed to one agent's declared capabilities (M18). It can
  // only deny actions the agent didn't declare — never widen authority — so the
  // executor running under it stays within the agent's spec. See AgentBroker.
  const agentBrokerAt = (cwd: string, agent: AgentSpec): AgentBroker =>
    new AgentBroker(new PolicyEngine(policyDoc, 'trusted'), audit, cwd, agent.capabilities);

  // Lazily-opened, runtime-owned resources (memoized so all consumers share one).
  let memoryStore: MemoryStore | undefined;
  let journalStore: TaskJournal | undefined;
  let core: ComputeCore | undefined;
  let host: Promise<PluginHost> | undefined;
  // The embedder persists a content vector with every memory write, so semantic
  // recall ranks against the stored matrix instead of re-embedding each query (M24).
  const memory = (): MemoryStore => (memoryStore ??= new MemoryStore(join(root, config.paths.memory), embedText));
  const journal = (): TaskJournal => (journalStore ??= new TaskJournal(join(root, config.paths.journal)));
  const computeCore = async (): Promise<ComputeCore> => (core ??= await loadComputeCore());

  const planner = (): Planner => new Planner(strategy);

  // Repo-map working set from the index (empty when no index exists yet).
  const repoMapContext = async (task: Task): Promise<string> => {
    const indexPath = join(root, config.paths.index);
    if (!existsSync(indexPath)) return '';
    const store = new IndexStore(indexPath);
    try {
      const assembled = await new ContextService(await computeCore(), store).assemble(
        task,
        config.budgets.contextTokensMax,
      );
      return assembled.text;
    } finally {
      store.close();
    }
  };

  // Prior runs of this goal, semantically reranked by the bundled retriever
  // (guarded on memory-db existence so a dry-run `plan` opens/creates nothing).
  const memoryContext = async (task: Task): Promise<string> => {
    if (!existsSync(join(root, config.paths.memory))) return '';
    const retriever = createPersistedRetriever(await computeCore(), memory(), 'episodic', task.goal);
    const hits = await retriever.retrieve(task.goal, 3);
    return hits.length ? `# Relevant prior runs for: ${task.goal}\n${hits.map((h) => `- ${h}`).join('\n')}\n` : '';
  };

  // Hits from external retriever-kind plugins (e.g. a vector DB or docs index),
  // cap-gated by the host; a refused/failing plugin simply contributes nothing.
  const pluginRetrieverContext = async (task: Task): Promise<string> => {
    const hits = await (await pluginHost()).runRetrievers(task.goal, 3);
    return hits.length ? `# Plugin retrievers for: ${task.goal}\n${hits.map((h) => `- ${h}`).join('\n')}\n` : '';
  };

  // Pinned ADRs (M16) whose text the task's intent terms name — the binding
  // decisions a change must respect, recalled into the Context Compiler (M17).
  const decisionsContext = (task: Task): string => {
    if (!existsSync(join(root, config.paths.memory))) return '';
    const terms = decomposeIntent(task.goal);
    if (terms.length === 0) return '';
    const hits = memory()
      .list('semantic')
      .filter((r) => r.id.startsWith('adr:'))
      .filter((r) => terms.some((t) => `${r.key} ${r.content}`.toLowerCase().includes(t)))
      .slice(0, 3);
    return hits.length
      ? `# Relevant decisions for: ${task.goal}\n${hits.map((h) => `- ${h.content.split('\n')[0]}`).join('\n')}\n`
      : '';
  };

  const context = async (task: Task): Promise<string> => {
    // The deterministic scaffolder ignores context, so don't pay to load the
    // index / WASM / memory / plugins for it. Returning '' also keeps a dry-run
    // `plan` writeless. Memory (prior runs) leads, then the decisions that bind
    // the change (ADRs), then the repo map, then any retriever-plugin hits.
    if (!llmPlanning) return '';
    const sections = [
      await memoryContext(task),
      decisionsContext(task),
      await repoMapContext(task),
      await pluginRetrieverContext(task),
    ];
    return sections.filter((s) => s.length > 0).join('\n');
  };

  // Pre-apply gate (M19): structural pre-write check the loop runs before opening
  // a worktree. Resolves the import edges the planned writes would add and runs
  // them, with the indexed edge set, through evaluatePreHooks — so a never-modify
  // write or a cycle-closing import is refused before anything is written. No
  // index yet ⇒ no structural signal ⇒ allow (the broker still gates each write).
  const preApply = async (writes: { target: string; content: string }[]): Promise<PreHookFinding[]> => {
    if (writes.length === 0) return [];
    // The never-modify check needs only the write targets; the cycle/leak checks
    // need the indexed edge set + the imports each write would add. With no index,
    // edges are empty (never-modify still fires) — the broker gates each write too.
    const indexPath = join(root, config.paths.index);
    let existingEdges: { src: string; dst: string }[] = [];
    let addedImports: { src: string; dst: string }[] = [];
    if (existsSync(indexPath)) {
      const store = new IndexStore(indexPath);
      try {
        existingEdges = store.loadFileEdges();
      } finally {
        store.close();
      }
      const onDisk = (rel: string): boolean => existsSync(join(root, ...rel.split('/')));
      addedImports = writes.flatMap(({ target, content }) =>
        extractImports(content)
          .map((spec) => resolveImport(target, spec, onDisk))
          .filter((dst): dst is string => dst !== undefined && dst !== target)
          .map((dst) => ({ src: target, dst })),
      );
    }
    return evaluatePreHooks({ writes: writes.map((w) => w.target), addedImports, existingEdges });
  };

  // Preservation pre-apply gate (M14/M20): the capstone that turns the advisory
  // simulation into a real loop-internal hard block. For each planned write to an
  // ALREADY-INDEXED source file it runs the same `assembleSimulation` the
  // `/simulate` and `/refactor` commands use; a `block` recommendation (a change
  // that would erase intentional/critical structure) becomes a blocking finding,
  // so the loop aborts before opening a worktree. Like every gate it can only
  // refuse, never grant — tighten, never widen. No index ⇒ no signal ⇒ allow.
  const preservationFindings = async (
    writes: { target: string; content: string }[],
  ): Promise<PreHookFinding[]> => {
    const indexPath = join(root, config.paths.index);
    if (writes.length === 0 || !existsSync(indexPath)) return [];
    const { indexer: idx, store, close } = await indexer();
    try {
      const findings: PreHookFinding[] = [];
      for (const { target } of writes) {
        // Classify the write as a `modify` — matching what `/simulate <file>`
        // shows by default, so the gate and the inspectable prediction agree. A
        // brand-new (unindexed) file returns null here: no structure to preserve.
        const report = await assembleSimulation(root, idx, store, target, 'modify' satisfies ChangeKind);
        if (report?.recommendation === 'block') {
          findings.push({
            hook: 'preservation',
            severity: 'block',
            subject: target,
            detail: report.rationale[report.rationale.length - 1] ?? 'preservation/never-modify block',
          });
        }
      }
      return findings;
    } finally {
      close();
    }
  };

  // M13: estimate the real blast radius of writing to a file by treating every
  // symbol it defines as "changed" and taking the reverse-reachable closure over
  // the symbol graph. This replaces the planner's safe-minimum stub (target file
  // only) with the true transitive impact, so the broker's Policy Engine can
  // apply the `blast_radius_files_*` rules. No index, or an unindexed/symbol-less
  // file ⇒ undefined: the planner's stub stands and the rules stay dormant.
  const blastRadiusFor = async (target: string): Promise<BlastRadius | undefined> => {
    const indexPath = join(root, config.paths.index);
    if (!existsSync(indexPath)) return undefined;
    const store = new IndexStore(indexPath);
    try {
      const seeds = store.allSymbols().filter((s) => s.file === target).map((s) => s.name);
      if (seeds.length === 0) return undefined;
      return await new SymbolGraph(store).blastRadius(seeds);
    } finally {
      store.close();
    }
  };

  const loop = (agent?: AgentSpec, opts: { force?: boolean } = {}): CognitionLoop =>
    new CognitionLoop({
      planner: planner(),
      // `trusted` so the worktree transaction's git ops are permitted; the broker
      // still gates each one, and all writes are confined to the worktree.
      transaction: new Transaction(brokerAt(root, 'trusted'), root, join(root, '.archon/worktrees')),
      reflector: new Reflector(memory()),
      journal: journal(),
      // The executor's authority is the agent's (capability-scoped) when one is
      // bound, else full trusted. Transaction/verifier stay trusted: an agent
      // scopes the *writes it proposes*, not the loop's git/verification plumbing.
      executorFor: (worktree, taskId) =>
        new Executor(agent ? agentBrokerAt(worktree, agent) : brokerAt(worktree, 'trusted'), taskId),
      verifierFor: (worktree) => new Verifier(brokerAt(worktree, 'trusted')),
      // Verifier plugins run under the host's (config-profile) broker, so one
      // needing a capability the profile won't grant stays inert rather than
      // gaining the loop's trusted authority — plugins tighten, never widen.
      verifierPlugins: async (files) => (await pluginHost()).runVerifiers(files),
      // M19 structural hooks always run (never-modify zones + import cycles are
      // non-overridable); the M14/M20 preservation block is added unless `force`.
      preApply: async (writes) => {
        const structural = await preApply(writes);
        if (opts.force) return structural;
        return [...structural, ...(await preservationFindings(writes))];
      },
      blastRadiusFor,
      cost: () => router.spent,
    });

  const retriever = async (tier: MemoryTier, key: string): Promise<RetrieverPlugin> => {
    const plugin = createPersistedRetriever(await computeCore(), memory(), tier, key);
    return plugin;
  };

  const indexer = async (): Promise<{ indexer: Indexer; store: IndexStore; close(): void }> => {
    const store = new IndexStore(join(root, config.paths.index));
    return {
      indexer: new Indexer(await computeCore(), store, new SymbolGraph(store), root, parseTsSymbols),
      store,
      close: () => store.close(),
    };
  };

  // Build the host once and load `.archon/plugins/<name>/plugin.mjs` (sibling of
  // the policy file). The dynamic import is host bootstrapping; loaded plugins
  // still receive no authority beyond what the broker grants at call time.
  const pluginHost = (): Promise<PluginHost> =>
    (host ??= (async () => {
      const h = new PluginHost(brokerAt(root));
      await h.load(join(root, dirname(config.paths.policy), 'plugins'));
      return h;
    })());

  const policy = (profile: Profile = config.profile): PolicyEngine => new PolicyEngine(policyDoc, profile);

  const close = (): void => {
    memoryStore?.close();
    journalStore?.close();
  };

  return {
    config,
    root,
    router,
    llmPlanning,
    providerStatus,
    planner,
    context,
    brokerAt,
    memory,
    journal,
    loop,
    retriever,
    indexer,
    pluginHost,
    policy,
    close,
  };
}
