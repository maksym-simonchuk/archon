import { describe, expect, it } from 'vitest';
import type { ModelSpec } from '../../core/types';
import { OpenAiClient } from './openai';

const model: ModelSpec = {
  id: 'gpt-x',
  provider: 'openai',
  contextWindow: 1000,
  costPer1kInput: 0,
  costPer1kOutput: 0,
  strengths: ['plan'],
};

describe('OpenAiClient (ProviderClient)', () => {
  it('POSTs to /v1/chat/completions with Bearer auth and parses content + usage', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'hello world' } }],
          usage: { prompt_tokens: 11, completion_tokens: 22 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const client = new OpenAiClient('sk-test', fetchImpl, 'https://api.example');
    const out = await client.complete(model, 'hi', 256);

    expect(out).toEqual({ text: 'hello world', inputTokens: 11, outputTokens: 22 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example/v1/chat/completions');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      model: 'gpt-x',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('throws (does not swallow) on a non-2xx response', async () => {
    const fetchImpl = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    const client = new OpenAiClient('sk', fetchImpl);
    await expect(client.complete(model, 'hi', 10)).rejects.toThrow(/openai 429/);
  });

  it('never embeds the api key in the error text on failure', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const client = new OpenAiClient('sk-secret-value', fetchImpl);
    await expect(client.complete(model, 'hi', 10)).rejects.toThrow(
      expect.not.stringContaining('sk-secret-value'),
    );
  });
});
