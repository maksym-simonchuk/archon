import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdModel } from './commands';
import type { ModelSpec } from './core/types';
import type { ProviderPlugin } from './plugins/abi';
import type { Runtime } from './runtime';
import { ProviderRouter, type ProviderClient } from './services/provider-router';

afterEach(() => vi.restoreAllMocks());

const model = (id: string, provider: string, strengths: ModelSpec['strengths']): ModelSpec => ({
  id,
  provider,
  contextWindow: 1000,
  costPer1kInput: 1,
  costPer1kOutput: 2,
  strengths,
});
const client = (provider: string): ProviderClient => ({
  provider,
  complete: () => Promise.reject(new Error('unused')),
  completeObject: () => Promise.reject(new Error('unused')),
});
const providerPlugin = (name: string): ProviderPlugin => ({
  kind: 'provider',
  manifest: { name, version: '0', kind: 'provider', capabilities: [] },
  complete: async (r) => ({ modelId: name, text: r.prompt, inputTokens: 0, outputTokens: 0, costUsd: 0, cached: false }),
});
const rtWith = (router: ProviderRouter): Runtime => ({ router }) as unknown as Runtime;
const captured = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
const text = (log: ReturnType<typeof captured>): string => log.mock.calls.flat().join('\n');

describe('cmdModel', () => {
  it('lists models with readiness and the per-task routing chain', async () => {
    const log = captured();
    const router = new ProviderRouter(
      [model('haiku', 'anthropic', ['plan', 'summarize']), model('opus', 'anthropic', ['reason'])],
      [client('anthropic')],
    );

    await cmdModel(rtWith(router));
    const out = text(log);

    expect(out).toContain('models (2 configured)');
    expect(out).toContain('✓ haiku'); // ready (client wired)
    expect(out).toMatch(/reason\s+opus/); // the reason task class routes to opus
  });

  it('marks a configured-but-keyless model not-ready and reports an empty registry', async () => {
    const log1 = captured();
    await cmdModel(rtWith(new ProviderRouter([model('opus', 'anthropic', ['reason'])], []))); // no client
    expect(text(log1)).toContain('○ opus');

    vi.restoreAllMocks();
    const log2 = captured();
    await cmdModel(rtWith(new ProviderRouter([], [])));
    expect(text(log2)).toContain('none configured');
  });

  it('flags a routing entry that points at an unregistered model with (?)', async () => {
    const log = captured();
    // `plan` prefers a model id that is not in the registry — a dangling config.
    const router = new ProviderRouter([model('opus', 'anthropic', ['reason'])], [client('anthropic')], {
      routing: { plan: 'ghost-model' },
    });

    await cmdModel(rtWith(router));
    const out = text(log);

    expect(out).toContain('ghost-model(?)');
    expect(out).toContain('skipped at run time');
  });

  it('lists provider-plugin fallbacks, even with no models configured', async () => {
    const log = captured();
    const router = new ProviderRouter([], [], { providerPlugins: () => Promise.resolve([providerPlugin('local')]) });

    await cmdModel(rtWith(router));
    const out = text(log);

    expect(out).not.toContain('none configured'); // a plugin fallback counts as configured
    expect(out).toContain('fallback providers (plugins'); // surfaced for `archon model`
    expect(out).toContain('local');
  });
});
