import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, Output, type LanguageModel } from 'ai';
import type { ZodType } from 'zod';
import type { ModelSpec } from '../../core/types';
import type { ProviderClient } from '../provider-router';

type FetchLike = typeof fetch;

/** Provider ids backed by an AI SDK provider package. */
export type AiProvider = 'anthropic' | 'openai';

/**
 * A `ProviderClient` backed by the Vercel AI SDK. One factory covers every
 * SDK-backed provider; the runtime picks the provider id and supplies the key
 * from the environment (never logged). `fetchImpl` is injectable — the SDK
 * routes its HTTP through it — so the request/response mapping stays testable
 * without network. `maxRetries: 0` keeps one call = one request, matching the
 * router's own retry/fallback policy rather than layering a second one underneath.
 *
 * Boundary note: the LLM call is the runtime's own inference substrate, not an
 * agent reaching the repo/OS, so it is NOT routed through the Capability Broker
 * (like the WASM compute core). The broker still gates every *effect the model
 * proposes* (fs/exec) at execution time, which is what actually contains a bad plan.
 */
export function createAiClient(provider: AiProvider, apiKey: string, fetchImpl?: FetchLike): ProviderClient {
  let resolve: (id: string) => LanguageModel;
  if (provider === 'anthropic') {
    const p = createAnthropic({ apiKey, fetch: fetchImpl });
    resolve = (id) => p(id);
  } else {
    const p = createOpenAI({ apiKey, fetch: fetchImpl });
    resolve = (id) => p.chat(id);
  }

  return {
    provider,
    async complete(spec: ModelSpec, prompt: string, maxTokens: number) {
      const { text, usage } = await generateText({
        model: resolve(spec.id),
        prompt,
        maxOutputTokens: maxTokens,
        maxRetries: 0,
      });
      return {
        text,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
      };
    },

    async completeObject<T>(spec: ModelSpec, prompt: string, maxTokens: number, schema: ZodType<T>) {
      // `Output.object` makes the provider emit JSON conforming to `schema`
      // (json-schema / tool mode), and the SDK validates it before returning —
      // replacing the planner's hand-rolled fence-stripping + shape guards.
      const { output, usage } = await generateText({
        model: resolve(spec.id),
        prompt,
        maxOutputTokens: maxTokens,
        maxRetries: 0,
        output: Output.object({ schema }),
      });
      return {
        object: output,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
      };
    },
  };
}
