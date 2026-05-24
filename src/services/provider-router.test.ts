import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ModelSpec, TaskClass } from '../core/types';
import type { ProviderPlugin } from '../plugins/abi';
import { type ArchonEvent, createEventBus } from './event-bus';
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

  it('accumulates input/output tokens and remembers the last model used', async () => {
    const router = new ProviderRouter(
      [model('cheap', 'a', ['plan'], 1), model('strong', 'b', ['reason'], 1)],
      [client('a'), client('b')],
    );
    expect(router.tokensIn).toBe(0);
    expect(router.tokensOut).toBe(0);
    expect(router.lastModel).toBeUndefined();

    await router.complete(req('plan', 'one'));
    expect(router.tokensIn).toBe(1000);
    expect(router.tokensOut).toBe(1000);
    expect(router.lastModel).toBe('cheap');

    await router.streamComplete(req('reason', 'two'), () => {});
    expect(router.tokensIn).toBe(2000);
    expect(router.tokensOut).toBe(2000);
    expect(router.lastModel).toBe('strong');

    // A cache hit on a repeated prompt is free of tokens and leaves lastModel intact.
    await router.complete(req('plan', 'one'));
    expect(router.tokensIn).toBe(2000);
    expect(router.lastModel).toBe('strong');
  });

  it('an aborted stream does not advance the token counters', async () => {
    const controller = new AbortController();
    const aborting: ProviderClient = {
      provider: 'a',
      complete: () => Promise.reject(new Error('unused')),
      completeObject: () => Promise.reject(new Error('unused')),
      completeStream: (_m, _p, _mt, signal) => {
        async function* gen(): AsyncGenerator<string> {
          yield 'par';
          controller.abort();
          if (signal?.aborted) return;
          yield 'nope';
        }
        return { textStream: gen(), usage: Promise.resolve({ inputTokens: 1000, outputTokens: 1000 }) };
      },
    };
    const router = new ProviderRouter([model('m', 'a', ['summarize'], 1)], [aborting]);
    await router.streamComplete(req('summarize', 'hi'), () => {}, controller.signal);
    expect(router.tokensIn).toBe(0);
    expect(router.tokensOut).toBe(0);
    expect(router.lastModel).toBeUndefined();
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

describe('ProviderRouter ↔ event bus (Runtime v2 / M25–M26)', () => {
  it('publishes one token.delta per chunk and a final tokens.usage when a bus is configured', async () => {
    const bus = createEventBus();
    const router = new ProviderRouter(
      [model('m1', 'a', ['summarize'])],
      [client('a', { tag: 'm1' })],
      { bus },
    );
    // Subscribe before the stream starts so no event is missed.
    const seen: ArchonEvent[] = [];
    const sub = bus.subscribe()[Symbol.asyncIterator]();
    const drain = (async () => {
      while (true) {
        const next = await sub.next();
        if (next.done) break;
        seen.push(next.value);
        if (next.value.kind === 'tokens.usage') break; // terminal event for one stream
      }
    })();

    const runId = 'run_test_1';
    const out = await router.streamComplete(req('summarize', 'hi'), () => {}, undefined, runId);
    await drain;

    const deltas = seen.filter((e) => e.kind === 'token.delta');
    const usage = seen.find((e) => e.kind === 'tokens.usage');
    expect(out.text).toBe('m1:streamed');
    // Two chunks yielded by the fake client → two deltas.
    expect(deltas).toHaveLength(2);
    expect(deltas.every((e) => (e as { runId: string }).runId === runId)).toBe(true);
    expect((deltas[0] as { provider: string }).provider).toBe('a');
    expect((deltas[0] as { modelId: string }).modelId).toBe('m1');
    expect(usage).toBeDefined();
    expect((usage as { usage: { costUsd: number } }).usage.costUsd).toBe(out.costUsd);
  });

  it('publishes nothing when the stream is aborted (no usage event, no cost)', async () => {
    const bus = createEventBus();
    const router = new ProviderRouter(
      [model('m1', 'a', ['summarize'])],
      // Slow stream: yield once, then wait on a never-resolving promise so the
      // abort path is the only termination route.
      [
        {
          provider: 'a',
          complete: async () => ({ text: 'x', inputTokens: 1, outputTokens: 1 }),
          completeObject: async (_m, _p, _mt, schema) => ({
            object: schema.parse({}),
            inputTokens: 1,
            outputTokens: 1,
          }),
          completeStream: (_m, _p, _mt, signal) => {
            async function* gen(): AsyncGenerator<string> {
              yield 'partial';
              await new Promise<void>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(new Error('aborted')));
              });
            }
            return { textStream: gen(), usage: new Promise(() => {}) }; // usage never resolves
          },
        },
      ],
      { bus },
    );

    const controller = new AbortController();
    const seen: ArchonEvent[] = [];
    const sub = bus.subscribe()[Symbol.asyncIterator]();
    const drain = (async () => {
      // Drain until the bus closes or we've collected the partial.
      while (true) {
        const next = await sub.next();
        if (next.done) break;
        seen.push(next.value);
      }
    })();

    setTimeout(() => controller.abort(), 5);
    const out = await router.streamComplete(req('summarize', 'p'), () => {}, controller.signal, 'r_abort');
    bus.close(); // end the drain loop
    await drain;

    expect(out.aborted).toBe(true);
    expect(out.costUsd).toBe(0);
    // We saw at least one delta (the partial) but never a tokens.usage event.
    expect(seen.some((e) => e.kind === 'token.delta')).toBe(true);
    expect(seen.some((e) => e.kind === 'tokens.usage')).toBe(false);
  });

  it('a noisy subscriber cannot break or slow the stream — the bus is observational only', async () => {
    // Slow subscriber: never reads. The router must still complete.
    const bus = createEventBus(2); // tiny ring forces drops
    const router = new ProviderRouter(
      [model('m1', 'a', ['summarize'])],
      [client('a', { tag: 'm1' })],
      { bus },
    );
    // Subscribe but never iterate — events will queue and overflow.
    bus.subscribe();
    const out = await router.streamComplete(req('summarize', 'hi'), () => {});
    expect(out.text).toBe('m1:streamed'); // stream completed normally
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
