import { describe, expect, it } from 'vitest';
import { createEventBus } from './event-bus';
import { exporterFromEnv, OtelExporter } from './otel';

describe('OtelExporter', () => {
  it('folds turn.start/done into a single span and POSTs OTLP JSON', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = async (url: string, init?: { body?: string }) => {
      seen.push({ url, body: JSON.parse((init?.body as string) ?? '{}') });
      return new Response('', { status: 200 });
    };
    const bus = createEventBus();
    const exp = new OtelExporter({ endpoint: 'https://otlp/v1/traces', fetch: fakeFetch as unknown as typeof fetch, batchSize: 1, flushIntervalMs: 50 });
    exp.attach(bus);
    bus.publish({ kind: 'turn.start', runId: 'r1', at: 1000, goal: 'do thing' });
    bus.publish({ kind: 'tokens.usage', runId: 'r1', at: 1010, provider: 'p', modelId: 'm', usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 } });
    bus.publish({ kind: 'turn.done', runId: 'r1', at: 1100, ok: true });
    await new Promise((r) => setTimeout(r, 60));
    await exp.flush();
    expect(seen.length).toBeGreaterThan(0);
    const body = seen[0]?.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }> };
    expect(body.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.name).toContain('turn:');
    await exp.stop();
    bus.close();
  });

  it('exporterFromEnv parses endpoint + headers', () => {
    const cfg = exporterFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://x/y',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer abc, x-tenant=acme',
    });
    expect(cfg?.endpoint).toBe('https://x/y');
    expect(cfg?.headers?.['Authorization']).toBe('Bearer abc');
    expect(cfg?.headers?.['x-tenant']).toBe('acme');
  });

  it('returns undefined when no endpoint is set', () => {
    expect(exporterFromEnv({})).toBeUndefined();
  });
});
