import { describe, expect, it } from 'vitest';

import { type ArchonEvent, createEventBus, newRunId } from './event-bus';

/** Drain at most `n` events from the bus, with a deadline so a hung test fails fast. */
async function take(it: AsyncIterable<ArchonEvent>, n: number, ms = 250): Promise<ArchonEvent[]> {
  const out: ArchonEvent[] = [];
  const iter = it[Symbol.asyncIterator]();
  const deadline = Date.now() + ms;
  while (out.length < n) {
    const left = Math.max(1, deadline - Date.now());
    const next = await Promise.race([
      iter.next(),
      new Promise<IteratorResult<ArchonEvent>>((res) =>
        setTimeout(() => res({ value: undefined, done: true }), left),
      ),
    ]);
    if (next.done) break;
    out.push(next.value);
  }
  // Cooperative close so the producer-side awaiter resolves.
  await iter.return?.();
  return out;
}

describe('InMemoryEventBus', () => {
  it('delivers events to a live subscriber in publish order', async () => {
    const bus = createEventBus();
    const runId = newRunId();
    const sub = bus.subscribe();
    const received = take(sub, 3);
    bus.publish({ kind: 'turn.start', runId, at: 1, goal: 'hello' });
    bus.publish({ kind: 'token.delta', runId, at: 2, provider: 'p', modelId: 'm', text: 'a' });
    bus.publish({ kind: 'token.delta', runId, at: 3, provider: 'p', modelId: 'm', text: 'b' });
    const events = await received;
    expect(events.map((e) => e.kind)).toEqual(['turn.start', 'token.delta', 'token.delta']);
    expect((events[1] as { text: string }).text).toBe('a');
  });

  it('respects filters — subscribers only see events matching their predicate', async () => {
    const bus = createEventBus();
    const runId = newRunId();
    const tokens = bus.subscribe((e) => e.kind === 'token.delta');
    const drained = take(tokens, 2);
    bus.publish({ kind: 'turn.start', runId, at: 1, goal: 'hi' });
    bus.publish({ kind: 'token.delta', runId, at: 2, provider: 'p', modelId: 'm', text: 'x' });
    bus.publish({ kind: 'token.delta', runId, at: 3, provider: 'p', modelId: 'm', text: 'y' });
    const events = await drained;
    expect(events.every((e) => e.kind === 'token.delta')).toBe(true);
    expect(events).toHaveLength(2);
  });

  it('fans out to multiple subscribers independently', async () => {
    const bus = createEventBus();
    const runId = newRunId();
    const a = take(bus.subscribe(), 2);
    const b = take(bus.subscribe(), 2);
    bus.publish({ kind: 'turn.start', runId, at: 1, goal: 'g' });
    bus.publish({ kind: 'turn.done', runId, at: 2, ok: true });
    const [aOut, bOut] = await Promise.all([a, b]);
    expect(aOut.map((e) => e.kind)).toEqual(['turn.start', 'turn.done']);
    expect(bOut.map((e) => e.kind)).toEqual(['turn.start', 'turn.done']);
  });

  it('drops oldest events when a subscriber falls behind and surfaces the loss', async () => {
    const bus = createEventBus(4); // tiny ring so we can overflow it deterministically
    const runId = newRunId();
    const sub = bus.subscribe();
    // Publish 10 events before iterating once — the ring of 4 must drop 6.
    for (let i = 0; i < 10; i++) {
      bus.publish({ kind: 'token.delta', runId, at: i, provider: 'p', modelId: 'm', text: String(i) });
    }
    const events = await take(sub, 5); // expect 1 bus.lost + 4 token.delta
    expect(events[0]?.kind).toBe('bus.lost');
    expect((events[0] as { dropped: number }).dropped).toBe(6);
    expect(events.slice(1).every((e) => e.kind === 'token.delta')).toBe(true);
  });

  it('close() ends all in-flight iterators cleanly', async () => {
    const bus = createEventBus();
    const sub = bus.subscribe();
    const iter = sub[Symbol.asyncIterator]();
    // Park the iterator awaiting; then close from the producer side.
    const pending = iter.next();
    bus.close();
    const result = await pending;
    expect(result.done).toBe(true);
  });

  it('publishing on a closed bus is a silent no-op (does not throw)', () => {
    const bus = createEventBus();
    bus.close();
    expect(() =>
      bus.publish({ kind: 'turn.start', runId: 'r', at: 1, goal: 'g' }),
    ).not.toThrow();
  });

  it('unsubscribing via iterator.return() removes the subscriber', async () => {
    const bus = createEventBus();
    const runId = newRunId();
    const iter = bus.subscribe()[Symbol.asyncIterator]();
    const first = iter.next();
    bus.publish({ kind: 'turn.start', runId, at: 1, goal: 'g' });
    await first;
    await iter.return?.();
    // After return, further publishes don't queue against this subscriber and
    // a subsequent next() resolves done — proves removal.
    bus.publish({ kind: 'turn.done', runId, at: 2, ok: true });
    const after = await iter.next();
    expect(after.done).toBe(true);
  });
});

describe('newRunId', () => {
  it('produces a stable, uniquely-prefixed id', () => {
    const a = newRunId();
    const b = newRunId();
    expect(a).not.toBe(b);
    expect(a.startsWith('run_')).toBe(true);
  });
});
