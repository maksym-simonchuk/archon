import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ModelSpec } from '../../core/types';
import { createAiClient } from './ai-sdk';

const spec = (id: string, provider: 'anthropic' | 'openai' | 'google' | 'local'): ModelSpec => ({
  id,
  provider,
  contextWindow: 1000,
  costPer1kInput: 0,
  costPer1kOutput: 0,
  strengths: ['plan'],
});

const jsonFetch = (calls: string[], body: unknown): typeof fetch =>
  (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

const OPENAI_OK = {
  id: 'x',
  object: 'chat.completion',
  created: 0,
  model: 'local-x',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello world' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 6 },
};

describe('createAiClient (AI SDK ProviderClient)', () => {
  it('routes Anthropic through /v1/messages and maps text + usage', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-x',
          content: [{ type: 'text', text: 'hello world' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 11, output_tokens: 22 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const client = createAiClient('anthropic', 'sk-test', { fetch: fetchImpl });
    const out = await client.complete(spec('claude-x', 'anthropic'), 'hi', 256);

    expect(out).toEqual({ text: 'hello world', inputTokens: 11, outputTokens: 22 });
    expect(calls.some((u) => u.includes('/v1/messages'))).toBe(true);
  });

  it('routes OpenAI through /chat/completions and maps text + usage', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-x',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello world' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 22 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const client = createAiClient('openai', 'sk-test', { fetch: fetchImpl });
    const out = await client.complete(spec('gpt-x', 'openai'), 'hi', 256);

    expect(out).toEqual({ text: 'hello world', inputTokens: 11, outputTokens: 22 });
    expect(calls.some((u) => u.includes('/chat/completions'))).toBe(true);
  });

  it('completeObject asks the provider for schema-shaped JSON and returns the typed object', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-x',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify({ title: 'hi', n: 3 }) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 7 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const client = createAiClient('openai', 'sk-test', { fetch: fetchImpl });
    const schema = z.object({ title: z.string(), n: z.number() });
    const out = await client.completeObject(spec('gpt-x', 'openai'), 'go', 128, schema);

    expect(out.object).toEqual({ title: 'hi', n: 3 });
    expect([out.inputTokens, out.outputTokens]).toEqual([5, 7]);
  });

  it('propagates a provider error instead of swallowing it', async () => {
    const fetchImpl = (async () =>
      new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } })) as typeof fetch;
    const client = createAiClient('anthropic', 'sk', { fetch: fetchImpl });
    await expect(client.complete(spec('claude-x', 'anthropic'), 'hi', 10)).rejects.toThrow();
  });

  it('routes Gemini through the Google generative-language endpoint', async () => {
    const calls: string[] = [];
    const fetchImpl = jsonFetch(calls, {
      candidates: [{ content: { parts: [{ text: 'hello world' }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8 },
    });
    const client = createAiClient('google', 'g-test', { fetch: fetchImpl });
    const out = await client.complete(spec('gemini-2.0-flash', 'google'), 'hi', 64);

    expect(out.text).toBe('hello world');
    expect(calls.some((u) => u.includes('generativelanguage.googleapis.com'))).toBe(true);
  });

  it('routes a local model through the configured OpenAI-compatible base URL', async () => {
    const calls: string[] = [];
    const fetchImpl = jsonFetch(calls, OPENAI_OK);
    const client = createAiClient('local', 'local', { fetch: fetchImpl, baseURL: 'http://localhost:11434/v1' });
    const out = await client.complete(spec('llama3.1', 'local'), 'hi', 64);

    expect(out).toEqual({ text: 'hello world', inputTokens: 5, outputTokens: 6 });
    expect(calls.some((u) => u.startsWith('http://localhost:11434/v1'))).toBe(true);
  });
});
