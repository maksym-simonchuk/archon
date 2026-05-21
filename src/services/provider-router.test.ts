import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ModelSpec, TaskClass } from '../core/types';
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
});

const req = (taskClass: TaskClass, prompt: string) => ({ taskClass, prompt, maxTokens: 256 });

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
});
