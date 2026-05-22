import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ModelSpec, TaskClass } from '../core/types';
import type { ProviderPlugin } from '../plugins/abi';
import { ProviderRouter, type ProviderClient } from './provider-router';

const model = (id: string, provider: string, strengths: TaskClass[], rate = 1): ModelSpec => ({
  id,
  provider,
  contextWindow: 100_000,
  costPer1kInput: rate,
  costPer1kOutput: rate,
  strengths,
});

// A client that echoes a fixed token cost; `fail` makes it throw (rate-limit sim).
// `completeObject` parses a fixed payload through the caller's schema, mirroring
// what the real SDK-backed client does (provider emits JSON → validated).
const client = (provider: string, opts: { fail?: boolean; tag?: string } = {}): ProviderClient => ({
  provider,
  complete: async (m) => {
    if (opts.fail) throw new Error(`${provider} unavailable`);
    return { text: `${opts.tag ?? m.id}:ok`, inputTokens: 1000, outputTokens: 1000 };
  },
  completeObject: async <T,>(m: ModelSpec, _p: string, _mt: number, schema: z.ZodType<T>) => {
    if (opts.fail) throw new Error(`${provider} unavailable`);
    return { object: schema.parse({ picked: opts.tag ?? m.id }), inputTokens: 1000, outputTokens: 1000 };
  },
  completeStream: (m: ModelSpec) => {
    const text = `${opts.tag ?? m.id}:streamed`;
    async function* gen(): AsyncGenerator<string> {
      yield text.slice(0, 2);
      yield text.slice(2);
    }
    return { textStream: gen(), usage: Promise.resolve({ inputTokens: 1000, outputTokens: 1000 }) };
  },
});

const req = (taskClass: TaskClass, prompt: string) => ({ taskClass, prompt, maxTokens: 256 });

// A self-pricing provider plugin: echoes the prompt and reports its own cost.
// `fail` throws (so the router skips to the next plugin / surfaces the model error).
const providerPlugin = (name: string, costUsd = 0, fail = false): ProviderPlugin => ({
  kind: 'provider',
  manifest: { name, version: '0', kind: 'provider', capabilities: [] },
  complete: async (r) => {
    if (fail) throw new Error(`${name} down`);
    return { modelId: `plugin:${name}`, text: `${name}:${r.prompt}`, inputTokens: 10, outputTokens: 20, costUsd, cached: false };
  },
});
const supply = (...ps: ProviderPlugin[]) => (): Promise<ProviderPlugin[]> => Promise.resolve(ps);

describe('ProviderRouter (M7)', () => {
  it('routes by task-class strength and charges the model rate', async () => {
    const router = new ProviderRouter(
      [model('cheap', 'a', ['plan'], 0.5), model('strong', 'b', ['reason'], 4)],
      [client('a'), client('b')],
    );
    const planned = await router.complete(req('plan', 'hi'));
    expect(planned.modelId).toBe('cheap');
    expect(planned.costUsd).toBeCloseTo((1000 / 1000) * 0.5 + (1000 / 1000) * 0.5); // in+out
    expect((await router.complete(req('reason', 'hi'))).modelId).toBe('strong');
  });

  it('serves an identical request from cache without re-charging', async () => {
    const router = new ProviderRouter([model('m', 'a', ['plan'])], [client('a')]);
    const first = await router.complete(req('plan', 'same'));
    const spentAfterFirst = router.spent;
    const second = await router.complete(req('plan', 'same'));
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(router.spent).toBe(spentAfterFirst); // cache hit costs nothing
  });

  it('falls back to the next model when a provider fails', async () => {
    const router = new ProviderRouter(
      [model('primary', 'a', ['diff']), model('backup', 'b', ['diff'])],
      [client('a', { fail: true }), client('b', { tag: 'backup' })],
      { fallback: ['backup'] },
    );
    const out = await router.complete(req('diff', 'patch'));
    expect(out.modelId).toBe('backup');
    expect(out.text).toBe('backup:ok');
  });

  it('trips the budget breaker once the spend ceiling is reached', async () => {
    const router = new ProviderRouter([model('m', 'a', ['plan'], 1)], [client('a')], { budgetUsd: 1.5 });
    await router.complete(req('plan', 'p1')); // spends $2 (1k in + 1k out @ $1/1k)
    await expect(router.complete(req('plan', 'p2'))).rejects.toThrow(/budget exhausted/);
  });

  it('completeObject routes + charges via the same core and returns the validated object', async () => {
    const router = new ProviderRouter([model('cheap', 'a', ['plan'], 0.5)], [client('a', { tag: 'A' })]);
    const out = await router.completeObject(req('plan', 'hi'), z.object({ picked: z.string() }));
    expect(out.object).toEqual({ picked: 'A' });
    expect(out.modelId).toBe('cheap');
    expect(out.costUsd).toBeCloseTo(1); // same charge path as complete()
  });

  it('completeObject falls back to the next model when a provider fails', async () => {
    const router = new ProviderRouter(
      [model('primary', 'a', ['diff']), model('backup', 'b', ['diff'])],
      [client('a', { fail: true }), client('b', { tag: 'backup' })],
      { fallback: ['backup'] },
    );
    const out = await router.completeObject(req('diff', 'patch'), z.object({ picked: z.string() }));
    expect(out.object).toEqual({ picked: 'backup' });
  });

  it('streamComplete emits each chunk through the callback, then charges once', async () => {
    const router = new ProviderRouter([model('cheap', 'a', ['summarize'], 0.5)], [client('a', { tag: 'A' })]);
    const chunks: string[] = [];
    const out = await router.streamComplete(req('summarize', 'hi'), (c) => chunks.push(c));
    expect(chunks).toEqual(['A:', 'streamed']); // delivered incrementally, not in one shot
    expect(out.text).toBe('A:streamed');
    expect(out.modelId).toBe('cheap');
    expect(out.costUsd).toBeCloseTo(1); // (1k in + 1k out) @ $0.5/1k — same charge math as complete()
    expect(router.spent).toBeCloseTo(1);
  });

  it('streamComplete still trips the budget breaker before opening a stream', async () => {
    const router = new ProviderRouter([model('m', 'a', ['summarize'], 1)], [client('a')], { budgetUsd: 1.5 });
    await router.streamComplete(req('summarize', 'p1'), () => {}); // spends $2
    await expect(router.streamComplete(req('summarize', 'p2'), () => {})).rejects.toThrow(/budget exhausted/);
  });

  it('streamComplete stops on abort, returns the partial text, and charges nothing', async () => {
    const controller = new AbortController();
    // After the first chunk the stream observes the abort and stops yielding —
    // modelling how the SDK's textStream halts once its abortSignal fires.
    const aborting: ProviderClient = {
      provider: 'a',
      complete: () => Promise.reject(new Error('unused')),
      completeObject: () => Promise.reject(new Error('unused')),
      completeStream: (_m, _p, _mt, signal) => {
        async function* gen(): AsyncGenerator<string> {
          yield 'par';
          controller.abort(); // user hits Ctrl-C mid-stream
          if (signal?.aborted) return;
          yield 'SHOULD-NOT-EMIT';
        }
        return { textStream: gen(), usage: Promise.resolve({ inputTokens: 1000, outputTokens: 1000 }) };
      },
    };
    const router = new ProviderRouter([model('m', 'a', ['summarize'], 1)], [aborting]);
    const chunks: string[] = [];
    const out = await router.streamComplete(req('summarize', 'hi'), (c) => chunks.push(c), controller.signal);

    expect(chunks).toEqual(['par']); // nothing after the abort reaches the callback
    expect(out.text).toBe('par');
    expect(out.aborted).toBe(true);
    expect(out.costUsd).toBe(0); // a cancelled stream isn't billed
    expect(router.spent).toBe(0); // …so the running total is untouched
  });

  it('routingTable reports per-model readiness and the resolved per-task chain', () => {
    const router = new ProviderRouter(
      [model('cheap', 'a', ['plan', 'summarize'], 0.5), model('strong', 'b', ['reason', 'diff'], 4)],
      [client('a')], // only provider 'a' has a wired client
    );
    const { models, routes } = router.routingTable();
    expect(models.find((m) => m.id === 'cheap')?.ready).toBe(true);
    expect(models.find((m) => m.id === 'strong')?.ready).toBe(false); // provider 'b' unwired
    expect(routes.find((r) => r.taskClass === 'plan')?.chain).toEqual(['cheap']);
    expect(routes.find((r) => r.taskClass === 'reason')?.chain).toEqual(['strong']);
    expect(routes.find((r) => r.taskClass === 'embed')?.chain).toEqual([]); // nothing serves embed
  });
});

describe('ProviderRouter provider-plugin fallback (ADR-0012)', () => {
  it('falls back to a provider plugin when no model routes, charging its self-reported cost', async () => {
    const router = new ProviderRouter([], [], { providerPlugins: supply(providerPlugin('local', 0.25)) });
    const out = await router.complete(req('reason', 'hi'));
    expect(out.modelId).toBe('plugin:local'); // the plugin self-identifies
    expect(out.text).toBe('local:hi');
    expect(out.costUsd).toBe(0.25);
    expect(router.spent).toBeCloseTo(0.25); // self-priced cost still hits the breaker tally
  });

  it('prefers a configured model and never consults the plugin', async () => {
    const calls: string[] = [];
    const spy: ProviderPlugin = {
      kind: 'provider',
      manifest: { name: 'local', version: '0', kind: 'provider', capabilities: [] },
      complete: async () => {
        calls.push('plugin');
        return { modelId: 'plugin:local', text: '', inputTokens: 0, outputTokens: 0, costUsd: 0, cached: false };
      },
    };
    const router = new ProviderRouter([model('m', 'a', ['plan'], 0.5)], [client('a', { tag: 'M' })], {
      providerPlugins: supply(spy),
    });
    const out = await router.complete(req('plan', 'hi'));
    expect(out.modelId).toBe('m'); // model won
    expect(calls).toEqual([]); // plugin never loaded/called
  });

  it('falls back to a plugin when every configured model fails', async () => {
    const router = new ProviderRouter([model('primary', 'a', ['diff'])], [client('a', { fail: true })], {
      providerPlugins: supply(providerPlugin('first', 0.1, true), providerPlugin('second', 0.2)),
    });
    const out = await router.complete(req('diff', 'patch'));
    expect(out.modelId).toBe('plugin:second'); // first plugin threw, second served
  });

  it('does not consult plugins once the budget breaker has tripped', async () => {
    const calls: string[] = [];
    const spy: ProviderPlugin = {
      kind: 'provider',
      manifest: { name: 'local', version: '0', kind: 'provider', capabilities: [] },
      complete: async () => {
        calls.push('plugin');
        return { modelId: 'plugin:local', text: '', inputTokens: 0, outputTokens: 0, costUsd: 0, cached: false };
      },
    };
    const router = new ProviderRouter([model('m', 'a', ['plan'], 1)], [client('a')], {
      budgetUsd: 1.5,
      providerPlugins: supply(spy),
    });
    await router.complete(req('plan', 'p1')); // spends $2 via the model
    await expect(router.complete(req('plan', 'p2'))).rejects.toThrow(/budget exhausted/);
    expect(calls).toEqual([]); // the breaker blocks the plugin fallback too
  });

  it('caches a plugin-served completion (second identical call is free)', async () => {
    const router = new ProviderRouter([], [], { providerPlugins: supply(providerPlugin('local', 0.25)) });
    const first = await router.complete(req('reason', 'same'));
    const spentAfterFirst = router.spent;
    const second = await router.complete(req('reason', 'same'));
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(router.spent).toBe(spentAfterFirst); // cache hit re-charges nothing
  });

  it('fallbackProviders lists the supplied plugin names for `archon model`', async () => {
    const router = new ProviderRouter([], [], {
      providerPlugins: supply(providerPlugin('local'), providerPlugin('remote')),
    });
    expect(await router.fallbackProviders()).toEqual(['local', 'remote']);
  });
});
