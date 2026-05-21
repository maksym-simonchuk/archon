import type { ModelSpec } from '../../core/types';
import type { ProviderClient } from '../provider-router';

type FetchLike = typeof fetch;

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * Anthropic Messages API client (`ProviderClient`). The key is read from the
 * environment by the runtime and passed in here — never logged, never persisted.
 *
 * Boundary note: an LLM API call is the runtime's own inference substrate, not
 * an agent reaching the repo/OS, so — like the WASM compute core — it is NOT
 * routed through the Capability Broker. The broker still gates every *effect the
 * model proposes* (fs/exec) at execution time, which is what actually contains a
 * bad plan. `fetchImpl`/`baseUrl` are injectable so the request/response mapping
 * is testable without network.
 */
export class AnthropicClient implements ProviderClient {
  readonly provider = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://api.anthropic.com',
  ) {}

  async complete(
    model: ModelSpec,
    prompt: string,
    maxTokens: number,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model.id,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`[archon] anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as AnthropicResponse;
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return {
      text,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  }
}
