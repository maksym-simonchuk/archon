import { describe, expect, it } from 'vitest';
import type { JournalKind } from '../core/types';
import type { ArchonEvent } from './event-bus';
import { TaskJournal } from './task-journal';

const entry = (taskId: string, kind: JournalKind, payload: unknown) => ({
  taskId,
  ts: new Date().toISOString(),
  kind,
  payload,
});

describe('TaskJournal (M0)', () => {
  it('assigns monotonic seq and replays a task in append order', async () => {
    const j = new TaskJournal(':memory:');
    const a = j.append(entry('t1', 'plan', { goal: 'x' }));
    const b = j.append(entry('t1', 'step', { stepId: 't1-s1' }));
    expect(b.seq).toBeGreaterThan(a.seq);

    const replayed = await j.replay('t1');
    expect(replayed.map((e) => e.kind)).toEqual(['plan', 'step']);
    expect(replayed[0]?.payload).toEqual({ goal: 'x' }); // round-trips through JSON
    j.close();
  });

  it('isolates entries by task and returns recent newest-first', async () => {
    const j = new TaskJournal(':memory:');
    j.append(entry('t1', 'plan', null));
    j.append(entry('t2', 'plan', null));
    j.append(entry('t2', 'verdict', { passed: true }));
    expect(await j.replay('t2')).toHaveLength(2);
    expect(j.recent(2).map((e) => e.seq)).toEqual([3, 2]); // newest first
    j.close();
  });

  it('records bus events and replays them in append order', () => {
    const j = new TaskJournal(':memory:');
    const start: ArchonEvent = { kind: 'turn.start', runId: 'run_a', at: 1, goal: 'g' };
    const delta: ArchonEvent = {
      kind: 'token.delta',
      runId: 'run_a',
      at: 2,
      provider: 'p',
      modelId: 'm',
      text: 'hi',
    };
    const done: ArchonEvent = { kind: 'turn.done', runId: 'run_a', at: 3, ok: true };
    const other: ArchonEvent = { kind: 'turn.start', runId: 'run_b', at: 4, goal: 'g2' };

    j.appendBusEvent(start);
    j.appendBusEvent(delta);
    j.appendBusEvent(done);
    j.appendBusEvent(other);

    const stream = j.replayBus('run_a');
    expect(stream.map((e) => e.kind)).toEqual(['turn.start', 'token.delta', 'turn.done']);
    expect(stream[1]?.event).toEqual(delta);

    const recent = j.recentRunIds();
    expect(recent.map((r) => r.runId)).toEqual(['run_b', 'run_a']);
    expect(recent[1]?.events).toBe(3);
    j.close();
  });
});
