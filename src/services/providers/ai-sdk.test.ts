import { describe, expect, it } from 'vitest';
import type { ModelSpec } from '../../core/types';
import { createAiClient } from './ai-sdk';

const spec = (id: string, provider: 'anthropic' | 'openai'): ModelSpec => ({
  id,
  provider,
  contextWindow: 1000,
  costPer1kInput: 0,
  costPer1kOutput: 0,
  strengths: ['plan'],
});

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

    const client = createAiClient('anthropic', 'sk-test', fetchImpl);
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

    const client = createAiClient('openai', 'sk-test', fetchImpl);
    const out = await client.complete(spec('gpt-x', 'openai'), 'hi', 256);

    expect(out).toEqual({ text: 'hello world', inputTokens: 11, outputTokens: 22 });
    expect(calls.some((u) => u.includes('/chat/completions'))).toBe(true);
  });

  it('propagates a provider error instead of swallowing it', async () => {
    const fetchImpl = (async () =>
      new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } })) as typeof fetch;
    const client = createAiClient('anthropic', 'sk', fetchImpl);
    await expect(client.complete(spec('claude-x', 'anthropic'), 'hi', 10)).rejects.toThrow();
  });
});
