import { describe, expect, it } from 'vitest';
import { createEventBus, type ArchonEvent } from '../services/event-bus';
import { fixtureSource, replay } from './replay';

describe('replay', () => {
  it('republishes events for the matching runId in order', async () => {
    const events: ArchonEvent[] = [
      { kind: 'turn.start', runId: 'r1', at: 1, goal: 'g' },
      { kind: 'token.delta', runId: 'other', at: 2, provider: 'p', modelId: 'm', text: 'no' },
      { kind: 'token.delta', runId: 'r1', at: 3, provider: 'p', modelId: 'm', text: 'a' },
      { kind: 'turn.done', runId: 'r1', at: 4, ok: true },
    ];
    const bus = createEventBus();
    const seen: ArchonEvent[] = [];
    const iter = bus.subscribe()[Symbol.asyncIterator]();
    const collect = (async () => {
      while (true) {
        const next = await iter.next();
        if (next.done) break;
        seen.push(next.value);
      }
    })();
    const r = await replay(fixtureSource(events), 'r1', bus);
    bus.close();
    await collect;
    expect(r.count).toBe(3);
    expect(seen.map((e) => e.kind)).toEqual(['turn.start', 'token.delta', 'turn.done']);
  });

  it('honours the limit option', async () => {
    const events: ArchonEvent[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'token.delta',
      runId: 'r',
      at: i,
      provider: 'p',
      modelId: 'm',
      text: String(i),
    }));
    const bus = createEventBus();
    const r = await replay(fixtureSource(events), 'r', bus, { limit: 3 });
    bus.close();
    expect(r.count).toBe(3);
  });
});
