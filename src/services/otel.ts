/**
 * OpenTelemetry exporter (M37). Subscribes to the event bus and emits OTLP
 * JSON over HTTP. We deliberately do not depend on `@opentelemetry/*` — the
 * OTLP HTTP/JSON protocol is small and stable; we keep zero new deps.
 *
 * Configured via env (off by default):
 *   OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp/v1/traces
 *   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer xxx
 */

import type { ArchonEvent, EventBus } from './event-bus';

export interface OtelExporterOptions {
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  /** Inject for tests; defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Flush every N spans (default 32). */
  batchSize?: number;
  /** Flush at most every N ms even if the batch isn't full (default 2000). */
  flushIntervalMs?: number;
}

interface Span {
  traceId: string;
  spanId: string;
  name: string;
  startMs: number;
  endMs?: number;
  attrs: Record<string, string | number | boolean>;
  status: 'unset' | 'ok' | 'error';
}

/** Run-scoped span builder; folds bus events into OTel-shaped spans. */
export class OtelExporter {
  private buffer: Span[] = [];
  private spansByRun = new Map<string, Map<string, Span>>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  constructor(private readonly opts: OtelExporterOptions) {
    this.batchSize = opts.batchSize ?? 32;
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
  }

  attach(bus: EventBus): void {
    void (async () => {
      for await (const e of bus.subscribe()) {
        if (this.stopped) break;
        this.ingest(e);
      }
    })();
  }

  /** Map an ArchonEvent into a span fragment + buffer for flush. */
  ingest(e: ArchonEvent): void {
    const runId = e.runId;
    const runSpans = this.spansByRun.get(runId) ?? new Map<string, Span>();
    this.spansByRun.set(runId, runSpans);
    const open = (name: string): Span => {
      const existing = runSpans.get(name);
      if (existing) return existing;
      const s: Span = {
        traceId: runId.padEnd(32, '0').slice(-32),
        spanId: `${name}-${e.at}`.padEnd(16, '0').slice(-16),
        name,
        startMs: e.at,
        attrs: {},
        status: 'unset',
      };
      runSpans.set(name, s);
      return s;
    };
    const close = (name: string, ok: boolean): void => {
      const s = runSpans.get(name);
      if (!s) return;
      s.endMs = e.at;
      s.status = ok ? 'ok' : 'error';
      this.buffer.push(s);
      runSpans.delete(name);
      if (this.buffer.length >= this.batchSize) void this.flush();
    };
    switch (e.kind) {
      case 'turn.start':
        open(`turn:${runId}`).attrs['goal'] = e.goal;
        break;
      case 'turn.done':
        close(`turn:${runId}`, e.ok);
        break;
      case 'token.delta': {
        const s = open(`turn:${runId}`);
        s.attrs['provider'] = e.provider;
        s.attrs['model'] = e.modelId;
        s.attrs['tokens'] = ((s.attrs['tokens'] as number | undefined) ?? 0) + 1;
        break;
      }
      case 'tokens.usage': {
        const s = open(`turn:${runId}`);
        s.attrs['input_tokens'] = ((s.attrs['input_tokens'] as number | undefined) ?? 0) + e.usage.inputTokens;
        s.attrs['output_tokens'] = ((s.attrs['output_tokens'] as number | undefined) ?? 0) + e.usage.outputTokens;
        s.attrs['cost_usd'] = ((s.attrs['cost_usd'] as number | undefined) ?? 0) + e.usage.costUsd;
        break;
      }
      case 'tool.start':
        open(`tool:${e.tool}`).attrs['args'] = e.argsSummary;
        break;
      case 'tool.result':
        close(`tool:${e.tool}`, e.ok);
        break;
      case 'verdict':
        open(`verdict:${runId}`).attrs['summary'] = e.summary;
        close(`verdict:${runId}`, e.ok);
        break;
      default:
        break;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, this.flushIntervalMs).unref?.() as ReturnType<typeof setTimeout>;
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: this.opts.serviceName ?? 'archon' } }] },
          scopeSpans: [
            {
              scope: { name: 'archon-runtime' },
              spans: batch.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                name: s.name,
                startTimeUnixNano: `${s.startMs}000000`,
                endTimeUnixNano: `${(s.endMs ?? s.startMs)}000000`,
                attributes: Object.entries(s.attrs).map(([k, v]) => ({
                  key: k,
                  value:
                    typeof v === 'string'
                      ? { stringValue: v }
                      : typeof v === 'number'
                        ? { doubleValue: v }
                        : { boolValue: v },
                })),
                status: { code: s.status === 'ok' ? 1 : s.status === 'error' ? 2 : 0 },
              })),
            },
          ],
        },
      ],
    };
    const fetchFn = this.opts.fetch ?? globalThis.fetch;
    if (!fetchFn) return;
    try {
      await fetchFn(this.opts.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.opts.headers ?? {}) },
        body: JSON.stringify(body),
      });
    } catch {
      // Telemetry must never break the engine — drop on failure.
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await this.flush();
    // Don't await subTask — it parks waiting on the bus, which the caller is
    // expected to close separately. We just mark ourselves stopped so the loop
    // exits on its next iteration once events flow.
  }

  /** For tests — current pending buffer length. */
  get pending(): number {
    return this.buffer.length;
  }
}

/** Read env to configure an exporter, or `undefined` if no endpoint is set. */
export function exporterFromEnv(env: NodeJS.ProcessEnv = process.env): OtelExporterOptions | undefined {
  const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (!endpoint) return undefined;
  const headers: Record<string, string> = {};
  const raw = env['OTEL_EXPORTER_OTLP_HEADERS'];
  if (raw) {
    for (const pair of raw.split(',')) {
      const [k, ...rest] = pair.split('=');
      if (k && rest.length > 0) headers[k.trim()] = rest.join('=').trim();
    }
  }
  return { endpoint, headers, serviceName: env['OTEL_SERVICE_NAME'] ?? 'archon' };
}
