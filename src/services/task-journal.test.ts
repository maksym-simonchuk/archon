import { describe, expect, it } from 'vitest';
import type { JournalKind } from '../core/types';
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
});
