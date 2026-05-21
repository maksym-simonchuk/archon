import { describe, expect, it } from 'vitest';
import type { ModelSpec } from '../../core/types';
import { AnthropicClient } from './anthropic';

const model: ModelSpec = {
  id: 'claude-x',
  provider: 'anthropic',
  contextWindow: 1000,
  costPer1kInput: 0,
  costPer1kOutput: 0,
  strengths: ['plan'],
};

describe('AnthropicClient (ProviderClient)', () => {
  it('POSTs to /v1/messages with auth headers and parses text blocks + usage', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          content: [
            { type: 'text', text: 'hello ' },
            { type: 'thinking', text: 'IGNORED' },
            { type: 'text', text: 'world' },
          ],
          usage: { input_tokens: 11, output_tokens: 22 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const client = new AnthropicClient('sk-test', fetchImpl, 'https://api.example');
    const out = await client.complete(model, 'hi', 256);

    // Only `text` blocks are concatenated; the thinking block is dropped.
    expect(out).toEqual({ text: 'hello world', inputTokens: 11, outputTokens: 22 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example/v1/messages');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      model: 'claude-x',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('throws (does not swallow) on a non-2xx response', async () => {
    const fetchImpl = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    const client = new AnthropicClient('sk', fetchImpl);
    await expect(client.complete(model, 'hi', 10)).rejects.toThrow(/anthropic 429/);
  });

  it('never embeds the api key in the error text on failure', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const client = new AnthropicClient('sk-secret-value', fetchImpl);
    await expect(client.complete(model, 'hi', 10)).rejects.toThrow(
      expect.not.stringContaining('sk-secret-value'),
    );
  });
});
