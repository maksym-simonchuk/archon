import { describe, expect, it } from 'vitest';
import { emitChange } from './emit';
import { MemorySpecStore, specArchive, specDiff, specStatus, specValidate } from './spec-commands';
import type { OpenSpecChange } from './types';

const change = (id: string): OpenSpecChange => ({
  id,
  proposal: { why: ['x'], what: ['y'], whyNow: ['now'] },
  tasks: [
    { done: true, text: 'first' },
    { done: false, text: 'second' },
  ],
  specs: [
    {
      context: 'auth',
      sections: {
        ADDED: [
          {
            name: 'add hashPassword',
            body: ['hash'],
            scenarios: [{ name: 'normal user', body: ['GIVEN/WHEN/THEN'] }],
          },
        ],
      },
    },
  ],
});

describe('/spec commands', () => {
  it('status lists active and archived ids', async () => {
    const store = new MemorySpecStore();
    const c1 = change('a');
    const c2 = change('b');
    store.seed(c1, emitChange(c1));
    store.seed(c2, emitChange(c2));
    await store.archiveChange('a');
    const s = await specStatus(store);
    expect(s.active).toEqual(['b']);
    expect(s.archived).toEqual(['a']);
  });

  it('diff summarises per-context deltas + task progress', async () => {
    const store = new MemorySpecStore();
    const c = change('with-tasks');
    store.seed(c, emitChange(c));
    const d = await specDiff(store, 'with-tasks');
    expect(d?.totalTasks).toBe(2);
    expect(d?.completedTasks).toBe(1);
    expect(d?.byContext[0]).toMatchObject({ context: 'auth', added: 1 });
  });

  it('validate returns issues for a malformed change', async () => {
    const store = new MemorySpecStore();
    const broken: OpenSpecChange = { ...change('broken'), proposal: { why: [], what: [], whyNow: [] } };
    store.seed(broken, emitChange(broken));
    const v = await specValidate(store, 'broken');
    expect(v?.ok).toBe(false);
  });

  it('archive refuses an invalid change', async () => {
    const store = new MemorySpecStore();
    const broken: OpenSpecChange = { ...change('bad'), tasks: [] };
    store.seed(broken, emitChange(broken));
    const r = await specArchive(store, 'bad');
    expect(r.ok).toBe(false);
  });

  it('archive moves a valid change from active → archived', async () => {
    const store = new MemorySpecStore();
    const c = change('ok');
    store.seed(c, emitChange(c));
    const r = await specArchive(store, 'ok');
    expect(r.ok).toBe(true);
    expect(await store.listActive()).toEqual([]);
    expect(await store.listArchived()).toEqual(['ok']);
  });
});
