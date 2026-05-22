import { moduleOf } from './boundaries';

/**
 * Intent-aware scope resolution (M17): decompose a task's goal into terms, find
 * the symbols/files it names, and lift those to a *bounded context* — the seed
 * modules plus their import-graph neighbors. This is what lets the Context
 * Compiler assemble a packet scoped to the task instead of the whole repo
 * (ADR-0006: compression, not ingestion). Pure: indexed symbols + file edges +
 * goal in, scope out — the ranking, budget, and rendering stay in the service.
 */

export interface ScopeInput {
  goal: string;
  symbols: { name: string; file: string; kind: string }[];
  /** File→file import edges (M8.5) — the module-neighborhood substrate. */
  fileEdges: { src: string; dst: string }[];
}

export interface IntentScope {
  /** Goal terms that resolved to ≥1 symbol or file. */
  matchedTerms: string[];
  /** Symbol ids the intent names directly (the change seeds). */
  seedSymbols: string[];
  /** Modules the seeds live in — the task's bounded context. */
  seedModules: string[];
  /** Seed modules ∪ their import neighbors — the dependency neighborhood. */
  scopeModules: string[];
  /** Every symbol id whose module is in scope — the in-scope working set. */
  scopedSymbols: string[];
}

/** Short, low-signal words that would over-match if treated as intent terms. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'add', 'fix', 'use', 'with', 'into', 'from', 'this', 'that',
  'make', 'new', 'all', 'any', 'run', 'let', 'get', 'set', 'put', 'why', 'how',
  'when', 'support', 'update', 'change', 'feature', 'implement', 'refactor',
]);

/** Decompose a goal into distinct lowercase intent terms (≥3 chars, no stopwords). */
export function decomposeIntent(goal: string): string[] {
  const terms = goal
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(terms)];
}

/** The `name` half of a `file#name` symbol id (or the whole id when unqualified). */
const bareName = (id: string): string => {
  const hash = id.lastIndexOf('#');
  return (hash === -1 ? id : id.slice(hash + 1)).toLowerCase();
};

export function resolveScope(input: ScopeInput): IntentScope {
  const terms = decomposeIntent(input.goal);
  const empty: IntentScope = { matchedTerms: [], seedSymbols: [], seedModules: [], scopeModules: [], scopedSymbols: [] };
  if (terms.length === 0) return empty;

  const matched = new Set<string>();
  const seedSymbols: string[] = [];
  for (const s of input.symbols) {
    const name = bareName(s.name);
    const file = s.file.toLowerCase();
    const hit = terms.filter((t) => name.includes(t) || file.includes(t));
    if (hit.length === 0) continue;
    seedSymbols.push(s.name);
    for (const t of hit) matched.add(t);
  }
  if (seedSymbols.length === 0) return empty;

  const fileOf = new Map(input.symbols.map((s) => [s.name, s.file] as const));
  const seedModules = new Set(seedSymbols.map((id) => moduleOf(fileOf.get(id) as string)));

  // Module adjacency lifted from file→file import edges (both directions).
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  };
  for (const e of input.fileEdges) {
    const a = moduleOf(e.src);
    const b = moduleOf(e.dst);
    link(a, b);
    link(b, a);
  }

  const scopeModules = new Set(seedModules);
  for (const m of seedModules) for (const n of adj.get(m) ?? []) scopeModules.add(n);

  const scopedSymbols = input.symbols.filter((s) => scopeModules.has(moduleOf(s.file))).map((s) => s.name);

  return {
    matchedTerms: [...matched].sort(),
    seedSymbols,
    seedModules: [...seedModules].sort(),
    scopeModules: [...scopeModules].sort(),
    scopedSymbols,
  };
}
