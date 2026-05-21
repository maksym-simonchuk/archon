import type { ZodType } from 'zod';
import type { Completion, ModelSpec, RouteRequest, TaskClass } from '../core/types';

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

  async complete(req: RouteRequest): Promise<Completion> {
    const cacheKey = `${req.taskClass}::${req.prompt}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return { ...cached, cached: true };

    const routed = await this.route(req.taskClass, (model, client) =>
      client
        .complete(model, req.prompt, req.maxTokens)
        .then((r) => ({ value: r.text, inputTokens: r.inputTokens, outputTokens: r.outputTokens })),
    );
    const completion: Completion = {
      modelId: routed.modelId,
      text: routed.value,
      inputTokens: routed.inputTokens,
      outputTokens: routed.outputTokens,
      costUsd: routed.costUsd,
      cached: false,
    };
    this.cache.set(cacheKey, completion);
    return completion;
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
  private async route<R>(
    taskClass: TaskClass,
    call: (model: ModelSpec, client: ProviderClient) => Promise<{ value: R; inputTokens: number; outputTokens: number }>,
  ): Promise<{ value: R; modelId: string; inputTokens: number; outputTokens: number; costUsd: number }> {
    if (this.opts.budgetUsd !== undefined && this.spentUsd >= this.opts.budgetUsd) {
      throw new Error(
        `[archon] provider budget exhausted ($${this.spentUsd.toFixed(2)} ≥ $${this.opts.budgetUsd.toFixed(2)})`,
      );
    }

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
