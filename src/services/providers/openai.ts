import type { ModelSpec } from '../../core/types';
import type { ProviderClient } from '../provider-router';

type FetchLike = typeof fetch;

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * OpenAI Chat Completions API client (`ProviderClient`). The key is read from
 * the environment by the runtime and passed in here — never logged, never
 * persisted.
 *
 * Boundary note: an LLM API call is the runtime's own inference substrate, not
 * an agent reaching the repo/OS, so — like the WASM compute core — it is NOT
 * routed through the Capability Broker. The broker still gates every *effect the
 * model proposes* (fs/exec) at execution time, which is what actually contains a
 * bad plan. `fetchImpl`/`baseUrl` are injectable so the request/response mapping
 * is testable without network.
 */
export class OpenAiClient implements ProviderClient {
  readonly provider = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://api.openai.com',
  ) {}

  async complete(
    model: ModelSpec,
    prompt: string,
    maxTokens: number,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: model.id,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`[archon] openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as OpenAiResponse;
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  }
}
