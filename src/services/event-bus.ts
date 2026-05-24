/**
 * In-process typed event bus — the Runtime v2 spine. Single-process by design
 * (see `docs/RUNTIME-V2.md` §4.1, ADR-0015). All v2 UI/observability surfaces
 * subscribe here; no producer ever blocks on a slow subscriber.
 *
 * - Publication is synchronous and never throws — a misbehaving subscriber must
 *   not stall the cognition loop.
 * - Subscribers receive events via `AsyncIterable<ArchonEvent>`; back-pressure
 *   is handled by a bounded per-subscriber ring (drop-oldest, surface drops via
 *   a `bus.lost` event on the same subscriber so loss is observable).
 * - Closing a subscriber (breaking out of `for await` or calling `.return()`)
 *   unsubscribes cleanly; the bus survives subscriber churn.
 *
 * The bus carries no authority — it is a wire, not a gate. Every side effect
 * still goes through the Capability Broker (ADR-0003).
 */

/** Token-cost telemetry from the provider router. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * The closed set of events the bus carries. Discriminated by `kind`. Add a new
 * shape here when a new surface needs to publish — never widen with `any`.
 * Every event carries `runId` so the UI/replay can correlate streams.
 */
export type ArchonEvent =
  | { kind: 'turn.start'; runId: string; at: number; goal: string }
  | { kind: 'turn.done'; runId: string; at: number; ok: boolean; summary?: string }
  | { kind: 'token.delta'; runId: string; at: number; provider: string; modelId: string; text: string }
  | { kind: 'tokens.usage'; runId: string; at: number; provider: string; modelId: string; usage: TokenUsage }
  | { kind: 'plan.ready'; runId: string; at: number; specPath: string }
  | { kind: 'tool.start'; runId: string; at: number; tool: string; argsSummary: string }
  | { kind: 'tool.result'; runId: string; at: number; tool: string; ok: boolean; summary: string }
  | { kind: 'approval.request'; runId: string; at: number; capability: string; target: string; blastRadius: number }
  | { kind: 'approval.resolve'; runId: string; at: number; decision: 'allow' | 'deny' }
  | { kind: 'verdict'; runId: string; at: number; ok: boolean; summary: string }
  | { kind: 'bus.lost'; runId: string; at: number; dropped: number };

/** A predicate over events; lets a subscriber pre-filter rather than fan-out everything. */
export type EventFilter = (e: ArchonEvent) => boolean;

export interface EventBus {
  /** Publish an event. Never throws; never blocks; safe to call from anywhere. */
  publish(e: ArchonEvent): void;
  /** Subscribe to a filtered stream of events. Break out of `for await` to unsubscribe. */
  subscribe(filter?: EventFilter): AsyncIterable<ArchonEvent>;
  /** Close the bus and notify all live subscribers (their iterators end cleanly). */
  close(): void;
}

/** Internal subscriber bookkeeping — one per active `for await` loop. */
interface Subscriber {
  queue: ArchonEvent[];
  // When the queue is empty and an iterator is awaiting, `resolve` is set; the
  // next `publish` calls it instead of pushing to the queue (zero-copy fast path).
  resolve: ((e: ArchonEvent | null) => void) | undefined;
  filter: EventFilter | undefined;
  closed: boolean;
  /**
   * Pending dropped-event count. Surfaced as a single coalesced `bus.lost`
   * event on the next iteration so loss is visible without a flood.
   */
  dropped: number;
  /** Last seen `runId` — used to stamp the coalesced `bus.lost` event. */
  lastRunId: string;
}

/** Per-subscriber soft cap; beyond this we drop oldest events (and surface the loss). */
const DEFAULT_RING_CAPACITY = 4096;

/**
 * Default in-process implementation. Subscribers compete fairly: each gets its
 * own ring, each publish O(n_subscribers). For a single-process runtime this
 * is fine (n ≈ 1–10). A cross-process bus would replace this class behind the
 * same interface.
 */
export class InMemoryEventBus implements EventBus {
  private readonly subs = new Set<Subscriber>();
  private isClosed = false;

  constructor(private readonly ringCapacity = DEFAULT_RING_CAPACITY) {}

  publish(e: ArchonEvent): void {
    if (this.isClosed) return; // closed bus drops silently; producers must not crash on shutdown
    for (const sub of this.subs) {
      if (sub.closed) continue;
      if (sub.filter && !sub.filter(e)) continue;
      sub.lastRunId = e.runId;
      // Hot path: an iterator is parked waiting — hand the event directly.
      if (sub.resolve) {
        const r = sub.resolve;
        sub.resolve = undefined;
        r(e);
        continue;
      }
      // Buffered path: enqueue, dropping oldest if over capacity.
      if (sub.queue.length >= this.ringCapacity) {
        sub.queue.shift();
        sub.dropped += 1;
      }
      sub.queue.push(e);
    }
  }

  subscribe(filter?: EventFilter): AsyncIterable<ArchonEvent> {
    const sub: Subscriber = {
      queue: [],
      resolve: undefined,
      filter,
      closed: false,
      dropped: 0,
      lastRunId: '',
    };
    this.subs.add(sub);
    const bus = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<ArchonEvent> {
        return {
          async next(): Promise<IteratorResult<ArchonEvent>> {
            // If we accumulated drops since the last yield, surface them first.
            if (sub.dropped > 0 && !sub.closed) {
              const lost: ArchonEvent = {
                kind: 'bus.lost',
                runId: sub.lastRunId,
                at: Date.now(),
                dropped: sub.dropped,
              };
              sub.dropped = 0;
              return { value: lost, done: false };
            }
            if (sub.queue.length > 0) {
              return { value: sub.queue.shift() as ArchonEvent, done: false };
            }
            if (sub.closed) {
              return { value: undefined, done: true };
            }
            const next = await new Promise<ArchonEvent | null>((res) => {
              sub.resolve = res;
            });
            if (next === null) return { value: undefined, done: true };
            return { value: next, done: false };
          },
          async return(): Promise<IteratorResult<ArchonEvent>> {
            sub.closed = true;
            sub.queue.length = 0;
            if (sub.resolve) {
              const r = sub.resolve;
              sub.resolve = undefined;
              r(null);
            }
            bus.subs.delete(sub);
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const sub of this.subs) {
      sub.closed = true;
      const r = sub.resolve;
      sub.resolve = undefined;
      if (r) r(null);
    }
    this.subs.clear();
  }
}

/** Construct a fresh bus. Sugar so callers don't need to know the class. */
export function createEventBus(ringCapacity?: number): EventBus {
  return new InMemoryEventBus(ringCapacity);
}

/** Stable `runId` generator. Crypto-random; safe to use as a correlation key. */
export function newRunId(): string {
  // `crypto.randomUUID` is available in Node ≥ 19; this project requires ≥ 24.
  return `run_${crypto.randomUUID()}`;
}
