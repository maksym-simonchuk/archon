import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, Output, streamText, type LanguageModel } from 'ai';
import type { ZodType } from 'zod';
import type { ModelSpec } from '../../core/types';
import type { ProviderClient } from '../provider-router';

type FetchLike = typeof fetch;

/** Provider ids backed by an AI SDK provider package (or an OpenAI-compatible local server). */
export type AiProvider = 'anthropic' | 'openai' | 'google' | 'local';

/** Extra wiring for a provider — an injectable fetch (for tests) and a base URL (for `local`). */
export interface AiClientOptions {
  /** Injectable fetch — the SDK routes its HTTP through it, so mapping is testable without network. */
  fetch?: FetchLike;
  /** OpenAI-compatible endpoint for the `local` provider (ollama / LM Studio / vLLM). */
  baseURL?: string;
}

/**
 * A `ProviderClient` backed by the Vercel AI SDK. One factory covers every
 * SDK-backed provider — Claude, OpenAI, Gemini, and a `local` OpenAI-compatible
 * server (ollama / LM Studio / vLLM, via a base URL). The runtime picks the
 * provider id and supplies the key from the environment (never logged). `fetch`
 * is injectable — the SDK routes its HTTP through it — so the request/response
 * mapping stays testable without network. `maxRetries: 0` keeps one call = one
 * request, matching the router's own retry/fallback policy rather than layering a
 * second one underneath.
 *
 * Boundary note: the LLM call is the runtime's own inference substrate, not an
 * agent reaching the repo/OS, so it is NOT routed through the Capability Broker
 * (like the WASM compute core). The broker still gates every *effect the model
 * proposes* (fs/exec) at execution time, which is what actually contains a bad plan.
 */
export function createAiClient(provider: AiProvider, apiKey: string, opts: AiClientOptions = {}): ProviderClient {
  const { fetch: fetchImpl, baseURL } = opts;
  let resolve: (id: string) => LanguageModel;
  if (provider === 'anthropic') {
    const p = createAnthropic({ apiKey, fetch: fetchImpl });
    resolve = (id) => p(id);
  } else if (provider === 'google') {
    const p = createGoogleGenerativeAI({ apiKey, fetch: fetchImpl });
    resolve = (id) => p(id);
  } else {
    // openai + local share the OpenAI chat protocol; `local` just points baseURL
    // at an OpenAI-compatible server (ollama exposes /v1, no real key needed).
    const p = createOpenAI({ apiKey, fetch: fetchImpl, baseURL });
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

    completeStream(spec: ModelSpec, prompt: string, maxTokens: number, signal?: AbortSignal) {
      const result = streamText({
        model: resolve(spec.id),
        prompt,
        maxOutputTokens: maxTokens,
        maxRetries: 0,
        // The SDK aborts the underlying HTTP request when `signal` fires, so a
        // Ctrl-C in `/ask` stops generation instead of just detaching the reader.
        abortSignal: signal,
      });
      return {
        textStream: result.textStream,
        // `result.usage` is a PromiseLike; Promise.resolve lifts it to a real
        // Promise so it satisfies the router's `usage: Promise<…>` contract.
        usage: Promise.resolve(result.usage).then((u) => ({
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
        })),
      };
    },
  };
}
