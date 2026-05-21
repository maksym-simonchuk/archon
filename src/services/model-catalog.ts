import type { ModelSpec } from '../core/types';

/**
 * Indicative built-in specs for known models (prices per 1k tokens, USD). Costs
 * are approximate and used ONLY for the router's budget breaker, never for
 * billing. Override or extend by adding entries to `archon.config.json`'s
 * provider list (a model id absent from this catalog is simply unroutable until
 * a spec exists for it).
 */
export const MODEL_CATALOG: Record<string, ModelSpec> = {
  'claude-opus-4-7': {
    id: 'claude-opus-4-7',
    provider: 'anthropic',
    contextWindow: 200_000,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    strengths: ['reason', 'diff', 'plan'],
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    contextWindow: 200_000,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    strengths: ['plan', 'reason', 'diff', 'summarize'],
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    contextWindow: 200_000,
    costPer1kInput: 0.0008,
    costPer1kOutput: 0.004,
    strengths: ['summarize', 'plan', 'embed'],
  },
};

/**
 * Resolve a config provider list (`{ id, models }`) into `ModelSpec`s from the
 * catalog. A model id is only resolved if the catalog entry's provider matches
 * the declared provider id; unknown ids are skipped (the router just won't route
 * to them) rather than throwing, so a typo degrades gracefully.
 */
export function resolveModels(providers: { id: string; models: string[] }[]): ModelSpec[] {
  const out: ModelSpec[] = [];
  for (const p of providers) {
    for (const modelId of p.models) {
      const spec = MODEL_CATALOG[modelId];
      if (spec && spec.provider === p.id) out.push(spec);
    }
  }
  return out;
}
