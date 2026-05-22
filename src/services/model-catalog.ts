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
  'claude-haiku-4-5-20251001': {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    contextWindow: 200_000,
    costPer1kInput: 0.0008,
    costPer1kOutput: 0.004,
    strengths: ['summarize', 'plan', 'embed'],
  },
  'gpt-4o': {
    id: 'gpt-4o',
    provider: 'openai',
    contextWindow: 128_000,
    costPer1kInput: 0.0025,
    costPer1kOutput: 0.01,
    strengths: ['reason', 'plan', 'diff'],
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    provider: 'openai',
    contextWindow: 128_000,
    costPer1kInput: 0.00015,
    costPer1kOutput: 0.0006,
    strengths: ['summarize', 'plan', 'embed'],
  },
  // Gemini — large-context ingestion / multimodal repository understanding (the
  // vision's "Gemini → large-scale ingestion"); 1M-token window, cheap.
  'gemini-2.0-flash': {
    id: 'gemini-2.0-flash',
    provider: 'google',
    contextWindow: 1_000_000,
    costPer1kInput: 0.0001,
    costPer1kOutput: 0.0004,
    strengths: ['summarize', 'embed', 'reason'],
  },
  'gemini-1.5-pro': {
    id: 'gemini-1.5-pro',
    provider: 'google',
    contextWindow: 2_000_000,
    costPer1kInput: 0.00125,
    costPer1kOutput: 0.005,
    strengths: ['reason', 'plan', 'summarize'],
  },
};

/**
 * A synthesized spec for a `local` model id — runs on the user's machine via an
 * OpenAI-compatible server (ollama / LM Studio), so it is free (cost 0) and its
 * id is user-chosen (`llama3.1`, `qwen2.5-coder`, …) rather than catalogued. The
 * vision's "local → cheap background analysis / indexing augmentation".
 */
function localSpec(id: string): ModelSpec {
  return {
    id,
    provider: 'local',
    contextWindow: 32_768,
    costPer1kInput: 0,
    costPer1kOutput: 0,
    strengths: ['summarize', 'embed', 'reason', 'plan', 'diff'],
  };
}

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
      // Local models are user-named and free, so they are synthesized rather than
      // catalogued; every other provider resolves against the catalog by id.
      if (p.id === 'local') {
        out.push(localSpec(modelId));
        continue;
      }
      const spec = MODEL_CATALOG[modelId];
      if (spec && spec.provider === p.id) out.push(spec);
    }
  }
  return out;
}
