import { describe, expect, it } from 'vitest';

import { type ArchonEvent, createEventBus, newRunId } from '../../services/event-bus';
import { PatchStore } from './patch-store';

const drain = async (sub: AsyncIterable<ArchonEvent>, n: number, ms = 100): Promise<ArchonEvent[]> => {
  const it = sub[Symbol.asyncIterator]();
  const out: ArchonEvent[] = [];
  const deadline = Date.now() + ms;
  while (out.length < n) {
    const left = Math.max(1, deadline - Date.now());
    const next = await Promise.race([
      it.next(),
      new Promise<IteratorResult<ArchonEvent>>((res) => setTimeout(() => res({ value: undefined, done: true }), left)),
    ]);
    if (next.done) break;
    out.push(next.value);
  }
  await it.return?.();
  return out;
};

describe('PatchStore', () => {
  it('stages a patch and publishes `patch.staged` with file + hunk counts', async () => {
    const bus = createEventBus();
    const store = new PatchStore(bus);
    const runId = newRunId();
    const sub = bus.subscribe();
    const received = drain(sub, 1);

    const snap = store.stage(
      [
        { path: 'src/a.ts', before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\n' },
        { path: 'src/b.ts', before: '', after: 'new\nfile\n' },
      ],
      runId,
    );

    expect(snap).toBeDefined();
    expect(store.current()).toBe(snap);
    const events = await received;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'patch.staged',
      runId,
      patchId: snap?.patchId,
      files: ['src/a.ts', 'src/b.ts'],
    });
    expect((events[0] as { hunks: number }).hunks).toBeGreaterThan(0);
  });

  it('returns nothing and stages nothing when no hunks would be produced', () => {
    const bus = createEventBus();
    const store = new PatchStore(bus);
    const snap = store.stage([{ path: 'src/a.ts', before: 'one\n', after: 'one\n' }], newRunId());
    expect(snap).toBeUndefined();
    expect(store.current()).toBeUndefined();
  });

  it('toggles a hunk and publishes `patch.toggled`', async () => {
    const bus = createEventBus();
    const store = new PatchStore(bus);
    const runId = newRunId();
    store.stage([{ path: 'src/a.ts', before: 'one\ntwo\nthree\n', after: 'ONE\ntwo\nTHREE\n' }], runId);
    const sub = bus.subscribe((e) => e.kind === 'patch.toggled');
    const received = drain(sub, 1);

    const result = store.toggle(0, 0);
    expect(result).toBe(false);
    const events = await received;
    expect(events[0]).toMatchObject({ kind: 'patch.toggled', editIndex: 0, hunkIndex: 0, accepted: false });
  });

  it('returns undefined when toggling a missing hunk', () => {
    const bus = createEventBus();
    const store = new PatchStore(bus);
    store.stage([{ path: 'src/a.ts', before: 'a\n', after: 'b\n' }], newRunId());
    expect(store.toggle(99, 0)).toBeUndefined();
    expect(store.toggle(0, 99)).toBeUndefined();
  });

  it('resolves to writes and clears state', async () => {
    const bus = createEventBus();
    const store = new PatchStore(bus);
    const runId = newRunId();
    store.stage(
      [
        { path: 'src/a.ts', before: 'a\nb\n', after: 'A\nb\n' },
        { path: 'src/b.ts', before: 'x\ny\n', after: 'x\nY\n' },
      ],
      runId,
    );
    // Reject the second file's only hunk.
    store.toggle(1, 0);
    const sub = bus.subscribe((e) => e.kind === 'patch.resolved');
    const received = drain(sub, 1);

    const result = store.resolve();
    expect(result).toBeDefined();
    expect(Object.keys(result?.resolved.writes ?? {})).toEqual(['src/a.ts']);
    expect(result?.resolved.rejected).toHaveLength(1);
    expect(store.current()).toBeUndefined();

    const events = await received;
    expect(events[0]).toMatchObject({ kind: 'patch.resolved', writes: 1, rejected: 1, errors: 0 });
  });

  it('discards staged state and publishes `patch.discarded`', async () => {
    const bus = createEventBus();
    const store = new PatchStore(bus);
    const runId = newRunId();
    store.stage([{ path: 'src/a.ts', before: 'a\n', after: 'b\n' }], runId);
    const sub = bus.subscribe((e) => e.kind === 'patch.discarded');
    const received = drain(sub, 1);

    expect(store.discard()).toBe(true);
    expect(store.current()).toBeUndefined();
    expect(store.discard()).toBe(false); // idempotent

    const events = await received;
    expect(events[0]?.kind).toBe('patch.discarded');
  });
});
