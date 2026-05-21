import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CognitionLoop } from './cognition/loop';
import { Executor } from './cognition/executor';
import { Planner } from './cognition/planner';
import { ProviderPlanner } from './cognition/provider-planner';
import { Reflector } from './cognition/reflector';
import { ScaffoldStrategy } from './cognition/scaffold-strategy';
import type { PlanStrategy } from './cognition/types';
import { Verifier } from './cognition/verifier';
import { loadComputeCore, type ComputeCore } from './core/compute';
import type { MemoryTier, Profile, Task } from './core/types';
import { AuditLog } from './effecting/audit-log';
import { CapabilityBroker } from './effecting/capability-broker';
import { loadPolicy, PolicyEngine, type PolicyDocument } from './effecting/policy-engine';
import { Transaction } from './effecting/transaction';
import { MemoryStore } from './memory/store';
import { createEmbeddingRetriever } from './plugins/builtin/embedding-retriever';
import type { RetrieverPlugin } from './plugins/abi';
import { ContextService } from './sensing/context-service';
import { Indexer } from './sensing/indexer';
import { IndexStore } from './sensing/store';
import { SymbolGraph } from './sensing/symbol-graph';
import { loadConfig, type ArchonConfig } from './services/config';
import { AnthropicClient } from './services/providers/anthropic';
import { resolveModels } from './services/model-catalog';
import { ProviderRouter, type ProviderClient } from './services/provider-router';
import { TaskJournal } from './services/task-journal';

/** Build the concrete provider clients for which an API key is present in env. */
function buildClients(providers: { id: string }[]): ProviderClient[] {
  const clients: ProviderClient[] = [];
  for (const p of providers) {
    if (p.id === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      clients.push(new AnthropicClient(process.env.ANTHROPIC_API_KEY));
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
  /** Full plan → act → verify → reflect loop, sharing this runtime's memory + journal. */
  loop(): CognitionLoop;
  /** A built-in embedding retriever over one memory anchor, registered with the host. */
  retriever(tier: MemoryTier, key: string): Promise<RetrieverPlugin>;
  /** An incremental indexer plus its index store (caller closes the returned store). */
  indexer(): Promise<{ indexer: Indexer; store: IndexStore; close(): void }>;
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
  });

  const llmPlanning = models.length > 0 && clients.length > 0;
  const strategy: PlanStrategy = llmPlanning ? new ProviderPlanner(router) : new ScaffoldStrategy();

  const brokerAt = (cwd: string, profile: Profile = config.profile): CapabilityBroker =>
    new CapabilityBroker(new PolicyEngine(policyDoc, profile), audit, cwd);

  // Lazily-opened, runtime-owned resources (memoized so all consumers share one).
  let memoryStore: MemoryStore | undefined;
  let journalStore: TaskJournal | undefined;
  let core: ComputeCore | undefined;
  const memory = (): MemoryStore => (memoryStore ??= new MemoryStore(join(root, config.paths.memory)));
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
    const retriever = createEmbeddingRetriever(await computeCore(), memory(), 'episodic', task.goal);
    const hits = await retriever.retrieve(task.goal, 3);
    return hits.length ? `# Relevant prior runs for: ${task.goal}\n${hits.map((h) => `- ${h}`).join('\n')}\n` : '';
  };

  const context = async (task: Task): Promise<string> => {
    // The deterministic scaffolder ignores context, so don't pay to load the
    // index / WASM / memory for it. Returning '' also keeps a dry-run `plan`
    // writeless. Memory (prior runs) is ordered ahead of the repo map.
    if (!llmPlanning) return '';
    const sections = [await memoryContext(task), await repoMapContext(task)];
    return sections.filter((s) => s.length > 0).join('\n');
  };

  const loop = (): CognitionLoop =>
    new CognitionLoop({
      planner: planner(),
      // `trusted` so the worktree transaction's git ops are permitted; the broker
      // still gates each one, and all writes are confined to the worktree.
      transaction: new Transaction(brokerAt(root, 'trusted'), root, join(root, '.archon/worktrees')),
      reflector: new Reflector(memory()),
      journal: journal(),
      executorFor: (worktree, taskId) => new Executor(brokerAt(worktree, 'trusted'), taskId),
      verifierFor: (worktree) => new Verifier(brokerAt(worktree, 'trusted')),
      cost: () => router.spent,
    });

  const retriever = async (tier: MemoryTier, key: string): Promise<RetrieverPlugin> => {
    const plugin = createEmbeddingRetriever(await computeCore(), memory(), tier, key);
    return plugin;
  };

  const indexer = async (): Promise<{ indexer: Indexer; store: IndexStore; close(): void }> => {
    const store = new IndexStore(join(root, config.paths.index));
    return {
      indexer: new Indexer(await computeCore(), store, new SymbolGraph(store), root),
      store,
      close: () => store.close(),
    };
  };

  const close = (): void => {
    memoryStore?.close();
    journalStore?.close();
  };

  return {
    config,
    root,
    router,
    llmPlanning,
    planner,
    context,
    brokerAt,
    memory,
    journal,
    loop,
    retriever,
    indexer,
    close,
  };
}
