import { describe, expect, it } from 'vitest';
import { resolveModels } from './model-catalog';

describe('resolveModels', () => {
  it('resolves catalogued models when the provider matches', () => {
    const out = resolveModels([
      { id: 'anthropic', models: ['claude-opus-4-7'] },
      { id: 'google', models: ['gemini-2.0-flash', 'gemini-1.5-pro'] },
    ]);
    expect(out.map((m) => m.id)).toEqual(['claude-opus-4-7', 'gemini-2.0-flash', 'gemini-1.5-pro']);
    expect(out.find((m) => m.id === 'gemini-2.0-flash')?.contextWindow).toBe(1_000_000);
  });

  it('skips a model whose id does not match its declared provider', () => {
    // gpt-4o is an openai model — declaring it under google must not resolve it.
    expect(resolveModels([{ id: 'google', models: ['gpt-4o'] }])).toEqual([]);
  });

  it('synthesizes a free, user-named spec for any local model id', () => {
    const out = resolveModels([{ id: 'local', models: ['llama3.1', 'qwen2.5-coder'] }]);
    expect(out.map((m) => m.id)).toEqual(['llama3.1', 'qwen2.5-coder']);
    expect(out.every((m) => m.provider === 'local' && m.costPer1kInput === 0 && m.costPer1kOutput === 0)).toBe(true);
  });
});
