import type { ComputeCore } from '../core/compute';
import type { RankedSymbol, RepoMapInput, Task } from '../core/types';
import { type IntentScope, resolveScope } from './context-scope';
import { SymbolGraph } from './symbol-graph';
import type { IndexStore } from './store';

/** Provenance of an intent-scoped packet (M17): why these symbols, not the repo. */
export interface ContextScope {
  /** Bounded-context modules the task was scoped to. */
  boundedContext: string[];
  /** Goal terms that resolved to code. */
  matchedTerms: string[];
  /** Count of symbols in the change-impact surface (blast radius of the seeds). */
  impactSurface: number;
}

/** Result of assembling a working set. `tokens` is guaranteed ≤ the budget. */
export interface AssembledContext {
  /** The rendered repo-map (highest-rank symbols first, with provenance). */
  text: string;
  /** Estimated token count (≈ chars / 4); never exceeds the requested budget. */
  tokens: number;
  /** Symbol ids included, in rank order — the working set's provenance. */
  included: string[];
  /** True when served from the in-memory cache (repo state + budget unchanged). */
  cached: boolean;
  /** Intent scope when the goal resolved to a bounded context; null on a global fallback. */
  scope: ContextScope | null;
}

/** Rough token estimate; deliberately conservative (over-counts, never under). */
const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * Assembles a token-budgeted working set: a repo-map (PageRank-ranked symbol
 * skeleton) rendered highest-rank-first, dropping the lowest-rank symbols once
 * the budget is hit — compression, not ingestion (ADR-0006). Ranking runs in the
 * Rust/WASM compute core (ADR-0011).
 *
 * Caching is in-memory and keyed by the repo-state fingerprint + budget, so an
 * identical repo state never recomputes the ranking. A persistent, hash-keyed
 * disk cache under `.archon/cache` lands once the Capability Broker (M3) exists
 * — the context service must not touch `fs` directly (AGENTS.md).
 */
export class ContextService {
  private readonly cache = new Map<string, Omit<AssembledContext, 'cached'>>();

  constructor(
    private readonly core: ComputeCore,
    private readonly store: IndexStore,
  ) {}

  async assemble(task: Task, budgetTokens: number): Promise<AssembledContext> {
    const key = this.cacheKey(task, budgetTokens);
    const hit = this.cache.get(key);
    if (hit) return { ...hit, cached: true };

    const symbols = this.store.allSymbols();
    const graph: RepoMapInput = {
      nodes: symbols.map((s) => s.name),
      edges: this.store.loadEdges().map((e) => ({ src: e.src, dst: e.dst })),
    };
    const ranked = await this.core.rankRepoMap(graph);
    const meta = new Map(symbols.map((s) => [s.name, { file: s.file, kind: s.kind }]));

    // M17: decompose intent → bounded-context scope + change-impact surface.
    // When the goal names nothing in the repo, fall back to the global repo-map.
    const scope = resolveScope({ goal: task.goal, symbols, fileEdges: this.store.loadFileEdges() });
    const priority =
      scope.seedSymbols.length > 0 ? await this.priorityIds(scope) : undefined;

    const built = this.renderWithinBudget(task, ranked, meta, budgetTokens, scope, priority);
    this.cache.set(key, built);
    return { ...built, cached: false };
  }

  /** Symbols to render first: the in-scope working set ∪ the seeds' blast radius (impact surface). */
  private async priorityIds(scope: IntentScope): Promise<{ ids: Set<string>; impact: number }> {
    const impact = (await new SymbolGraph(this.store).blastRadius(scope.seedSymbols)).symbols;
    return { ids: new Set([...scope.scopedSymbols, ...impact]), impact: impact.length };
  }

  /**
   * Goal + budget + repo-state fingerprint. The goal is part of the key because
   * it is rendered into the assembled text (the header), so two tasks with the
   * same repo state but different goals must not collide on a cached result.
   */
  private cacheKey(task: Task, budgetTokens: number): string {
    const fingerprint = this.store
      .allFileHashes()
      .map((f) => `${f.path}:${f.hash}`)
      .join('\n');
    return `${task.goal}::${budgetTokens}::${fingerprint}`;
  }

  private renderWithinBudget(
    task: Task,
    ranked: RankedSymbol[],
    meta: Map<string, { file: string; kind: string }>,
    budgetTokens: number,
    scope: IntentScope,
    priority?: { ids: Set<string>; impact: number },
  ): Omit<AssembledContext, 'cached'> {
    const scoped = priority !== undefined;
    const provenance: ContextScope | null = scoped
      ? { boundedContext: scope.scopeModules, matchedTerms: scope.matchedTerms, impactSurface: priority.impact }
      : null;

    const header = scoped
      ? `# Context for: ${task.goal}\n` +
        `# bounded context: ${scope.scopeModules.join(', ')} (matched: ${scope.matchedTerms.join(', ')}) · impact surface: ${priority.impact} symbol(s)\n`
      : `# Repo map for: ${task.goal}\n`;
    let tokens = estimateTokens(header);
    if (tokens > budgetTokens) return { text: '', tokens: 0, included: [], scope: provenance };

    // Render in-scope/impact symbols first (highest rank within each tier), then
    // backfill with the global ranking until the budget is exhausted.
    const inScope = (id: string): boolean => scoped && priority.ids.has(id);
    const order = scoped
      ? [...ranked].sort((a, b) => Number(inScope(b.id)) - Number(inScope(a.id)))
      : ranked;

    const lines: string[] = [];
    const included: string[] = [];
    for (const { id, score } of order) {
      const m = meta.get(id);
      if (!m) continue;
      const tag = inScope(id) ? '* ' : '  ';
      const line = `- ${tag}${id} [${m.kind}] (${m.file}) score=${score.toFixed(4)}\n`;
      const cost = estimateTokens(line);
      if (tokens + cost > budgetTokens) break;
      lines.push(line);
      included.push(id);
      tokens += cost;
    }

    const text = header + lines.join('');
    return { text, tokens: estimateTokens(text), included, scope: provenance };
  }
}
