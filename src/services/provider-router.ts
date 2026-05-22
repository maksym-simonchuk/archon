import type { ZodType } from 'zod';
import { type Completion, type ModelSpec, type RouteRequest, type TaskClass, TASK_CLASSES } from '../core/types';
import type { ProviderPlugin } from '../plugins/abi';

/** A model in the registry plus whether a client backs it — read-only introspection. */
export interface ModelInfo {
  id: string;
  provider: string;
  strengths: TaskClass[];
  costPer1kInput: number;
  costPer1kOutput: number;
  ready: boolean;
}

/** The router's resolved routing, for `/model`: the registry + the per-task chain. */
export interface RoutingTable {
  models: ModelInfo[];
  routes: { taskClass: TaskClass; chain: string[] }[];
}

/** A provider's completion backend. HTTP clients (prod) and fakes (tests) share this. */
export interface ProviderClient {
  /** Provider id this client serves (matches `ModelSpec.provider`). */
  readonly provider: string;
  complete(
    model: ModelSpec,
    prompt: string,
    maxTokens: number,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
  /** Structured variant: the provider emits JSON conforming to `schema`, validated before return. */
  completeObject<T>(
    model: ModelSpec,
    prompt: string,
    maxTokens: number,
    schema: ZodType<T>,
  ): Promise<{ object: T; inputTokens: number; outputTokens: number }>;
  /**
   * Optional streaming text. Providers that implement it enable
   * `router.streamComplete` (the shell's `/ask`); `usage` resolves when the
   * stream finishes, for cost accounting. An optional `signal` lets the caller
   * cancel an in-flight stream (Ctrl-C) — implementations should stop yielding.
   */
  completeStream?(
    model: ModelSpec,
    prompt: string,
    maxTokens: number,
    signal?: AbortSignal,
  ): { textStream: AsyncIterable<string>; usage: Promise<{ inputTokens: number; outputTokens: number }> };
}

/** Result of a structured completion — like `Completion`, but carrying a typed object instead of text. */
export interface ObjectCompletion<T> {
  object: T;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RouterOptions {
  /** Preferred model id per task class (overrides strength-based selection). */
  routing?: Partial<Record<TaskClass, string>>;
  /** Ordered model ids to try after the preferred/strength picks, on failure. */
  fallback?: string[];
  /** Spend ceiling for this router; once reached, `complete` trips the breaker. */
  budgetUsd?: number;
  /**
   * Lazy supplier of provider-kind plugins, tried by `complete` as a self-priced
   * terminal fallback once no configured model serves a request. Memoized on
   * first use, so plugins load only when actually needed. See ADR-0012.
   */
  providerPlugins?: () => Promise<ProviderPlugin[]>;
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];

/**
 * Picks a model by task class (cheap for plan/summarize, strong for reason/diff),
 * with an exact prompt cache, a fallback chain on error/rate-limit, and a budget
 * circuit-breaker. Providers are injected (HTTP clients in prod, fakes in tests),
 * so the routing policy is fully testable without network. See ADR-0007.
 */
export class ProviderRouter {
  private readonly models: Map<string, ModelSpec>;
  private readonly clients: Map<string, ProviderClient>;
  private readonly cache = new Map<string, Completion>();
  private spentUsd = 0;
  private pluginCache?: ProviderPlugin[]; // memoized provider-plugin fallback list

  constructor(
    registry: ModelSpec[],
    clients: ProviderClient[] = [],
    private readonly opts: RouterOptions = {},
  ) {
    this.models = new Map(registry.map((m) => [m.id, m]));
    this.clients = new Map(clients.map((c) => [c.provider, c]));
  }

  /** Total cost charged so far (sum of non-cached completions). */
  get spent(): number {
    return this.spentUsd;
  }

  /**
   * Read-only routing introspection (powers `archon model` / `/model`): every
   * registered model with whether a client backs it, and the resolved model
   * chain per task class (first entry = the model that will be chosen). Pure —
   * it performs no provider calls.
   */
  routingTable(): RoutingTable {
    const models = [...this.models.values()].map((m) => ({
      id: m.id,
      provider: m.provider,
      strengths: m.strengths,
      costPer1kInput: m.costPer1kInput,
      costPer1kOutput: m.costPer1kOutput,
      ready: this.clients.has(m.provider),
    }));
    const routes = TASK_CLASSES.map((taskClass) => ({ taskClass, chain: this.routeChain(taskClass) }));
    return { models, routes };
  }

  async complete(req: RouteRequest): Promise<Completion> {
    const cacheKey = `${req.taskClass}::${req.prompt}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return { ...cached, cached: true };

    // Guard the budget up front so a blown ceiling blocks BOTH configured models
    // and the provider-plugin fallback (ADR-0012) — never silently switch lanes.
    this.budgetGuard();

    let completion: Completion;
    try {
      const routed = await this.route(req.taskClass, (model, client) =>
        client
          .complete(model, req.prompt, req.maxTokens)
          .then((r) => ({ value: r.text, inputTokens: r.inputTokens, outputTokens: r.outputTokens })),
      );
      completion = {
        modelId: routed.modelId,
        text: routed.value,
        inputTokens: routed.inputTokens,
        outputTokens: routed.outputTokens,
        costUsd: routed.costUsd,
        cached: false,
      };
    } catch (modelErr) {
      // No configured model served the request — try provider plugins as a
      // self-priced terminal fallback. If none can, surface the model error.
      const viaPlugin = await this.completeViaPlugin(req);
      if (!viaPlugin) throw modelErr;
      completion = viaPlugin;
    }
    this.cache.set(cacheKey, completion);
    return completion;
  }

  /** Provider plugins from the supplier, loaded + memoized on first fallback. */
  private async loadProviderPlugins(): Promise<ProviderPlugin[]> {
    if (!this.opts.providerPlugins) return [];
    return (this.pluginCache ??= await this.opts.providerPlugins());
  }

  /** Names of the granted provider plugins available as fallback (for `archon model`). */
  async fallbackProviders(): Promise<string[]> {
    return (await this.loadProviderPlugins()).map((p) => p.manifest.name);
  }

  /**
   * Try each provider plugin in order until one returns a completion. The plugin
   * prices itself, so its `costUsd` is added to the running spend (keeping the
   * breaker honest); a throwing plugin is skipped. Returns null when no plugin
   * serves the request. See ADR-0012.
   */
  private async completeViaPlugin(req: RouteRequest): Promise<Completion | null> {
    for (const plugin of await this.loadProviderPlugins()) {
      try {
        const c = await plugin.complete(req);
        this.spentUsd += c.costUsd;
        return { ...c, cached: false };
      } catch {
        // this plugin failed — fall through to the next
      }
    }
    return null;
  }

  /**
   * Structured sibling of `complete`: routes/charges/falls-back identically, but
   * asks the provider for JSON conforming to `schema` (validated before return).
   * Uncached — callers that want a plan re-derived per task expect a fresh call.
   */
  async completeObject<T>(req: RouteRequest, schema: ZodType<T>): Promise<ObjectCompletion<T>> {
    const routed = await this.route(req.taskClass, (model, client) =>
      client
        .completeObject(model, req.prompt, req.maxTokens, schema)
        .then((r) => ({ value: r.object, inputTokens: r.inputTokens, outputTokens: r.outputTokens })),
    );
    return {
      object: routed.value,
      modelId: routed.modelId,
      inputTokens: routed.inputTokens,
      outputTokens: routed.outputTokens,
      costUsd: routed.costUsd,
    };
  }

  /**
   * Shared routing core for `complete`/`completeObject`: budget breaker, the
   * task-class route chain, fallback on provider error, and cost accounting. The
   * caller supplies the per-attempt provider call and gets back the produced
   * value plus the charged model + tokens.
   */
  /**
   * Stream a text completion to `onChunk` as tokens arrive, charging after the
   * stream ends. Unlike `complete`, there is no mid-stream fallback — once a
   * model is chosen and the first token is emitted, we commit to it (budget is
   * still guarded up front). Powers the shell's `/ask`.
   *
   * Pass `signal` to make the stream cancellable (Ctrl-C). On abort we stop
   * consuming, return the partial text with `aborted: true`, and charge
   * nothing — a stream the user killed isn't billed, and the provider's `usage`
   * promise may never resolve once aborted, so we don't await it.
   */
  async streamComplete(
    req: RouteRequest,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<{ modelId: string; text: string; costUsd: number; aborted: boolean }> {
    this.budgetGuard();
    for (const modelId of this.routeChain(req.taskClass)) {
      const model = this.models.get(modelId);
      const client = model && this.clients.get(model.provider);
      if (!model || !client?.completeStream) continue;
      const { textStream, usage } = client.completeStream(model, req.prompt, req.maxTokens, signal);
      let text = '';
      let aborted = false;
      try {
        for await (const chunk of textStream) {
          text += chunk;
          onChunk(chunk);
        }
      } catch (e) {
        if (signal?.aborted) aborted = true; // cancellation surfaced as a throw
        else throw e; // a real provider error — let it propagate
      }
      if (signal?.aborted) aborted = true; // or a cooperative stop with no throw
      let costUsd = 0;
      if (!aborted) {
        const { inputTokens, outputTokens } = await usage;
        costUsd =
          (inputTokens / 1000) * model.costPer1kInput + (outputTokens / 1000) * model.costPer1kOutput;
        this.spentUsd += costUsd;
      }
      return { modelId, text, costUsd, aborted };
    }
    throw new Error(`[archon] no streaming model routes to task class "${req.taskClass}"`);
  }

  private budgetGuard(): void {
    if (this.opts.budgetUsd !== undefined && this.spentUsd >= this.opts.budgetUsd) {
      throw new Error(
        `[archon] provider budget exhausted ($${this.spentUsd.toFixed(2)} ≥ $${this.opts.budgetUsd.toFixed(2)})`,
      );
    }
  }

  private async route<R>(
    taskClass: TaskClass,
    call: (model: ModelSpec, client: ProviderClient) => Promise<{ value: R; inputTokens: number; outputTokens: number }>,
  ): Promise<{ value: R; modelId: string; inputTokens: number; outputTokens: number; costUsd: number }> {
    this.budgetGuard();

    const chain = this.routeChain(taskClass);
    if (chain.length === 0) throw new Error(`[archon] no model routes to task class "${taskClass}"`);

    let lastError: unknown;
    for (const modelId of chain) {
      const model = this.models.get(modelId);
      const client = model && this.clients.get(model.provider);
      if (!model || !client) continue;
      try {
        const { value, inputTokens, outputTokens } = await call(model, client);
        const costUsd =
          (inputTokens / 1000) * model.costPer1kInput + (outputTokens / 1000) * model.costPer1kOutput;
        this.spentUsd += costUsd;
        return { value, modelId, inputTokens, outputTokens, costUsd };
      } catch (e) {
        lastError = e; // provider failed — fall through to the next in the chain
      }
    }
    throw new Error(
      `[archon] all providers failed for "${taskClass}": ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  /** Preferred model, then strength-matched models, then the static fallback chain. */
  private routeChain(taskClass: TaskClass): string[] {
    const preferred = this.opts.routing?.[taskClass];
    const byStrength = [...this.models.values()]
      .filter((m) => m.strengths.includes(taskClass))
      .map((m) => m.id);
    return dedupe([...(preferred ? [preferred] : []), ...byStrength, ...(this.opts.fallback ?? [])]);
  }
}
