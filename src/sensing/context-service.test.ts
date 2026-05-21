import { describe, expect, it } from 'vitest';
import { loadComputeCore } from '../core/compute';
import type { Task } from '../core/types';
import { ContextService } from './context-service';
import { IndexStore } from './store';

const task: Task = { id: 't1', goal: 'understand auth', profile: 'safe', createdAt: '2026-05-21' };

// a -> c and b -> c : c is the hub, so PageRank ranks it first.
function seed(store: IndexStore): void {
  store.replaceFileGraph('a.ts', [{ name: 'a.ts#a', kind: 'function' }], [
    { src: 'a.ts#a', dst: 'c.ts#c', kind: 'calls' },
  ]);
  store.replaceFileGraph('b.ts', [{ name: 'b.ts#b', kind: 'function' }], [
    { src: 'b.ts#b', dst: 'c.ts#c', kind: 'calls' },
  ]);
  store.replaceFileGraph('c.ts', [{ name: 'c.ts#c', kind: 'function' }], []);
  store.upsertFileHash('a.ts', 'ha');
  store.upsertFileHash('b.ts', 'hb');
  store.upsertFileHash('c.ts', 'hc');
}

describe('ContextService (M2)', () => {
  it('ranks the hub first, stays within budget, and caches identical repo state', async () => {
    const core = await loadComputeCore();
    const store = new IndexStore(':memory:');
    seed(store);
    const svc = new ContextService(core, store);

    const out = await svc.assemble(task, 200);
    expect(out.tokens).toBeLessThanOrEqual(200);
    expect(out.included[0]).toBe('c.ts#c');
    expect(out.included).toHaveLength(3);
    expect(out.cached).toBe(false);

    const again = await svc.assemble(task, 200);
    expect(again.cached).toBe(true);
    expect(again.text).toBe(out.text);

    store.close();
  });

  it('drops lowest-rank symbols under a tight budget without exceeding it', async () => {
    const core = await loadComputeCore();
    const store = new IndexStore(':memory:');
    seed(store);
    const svc = new ContextService(core, store);

    const tight = await svc.assemble(task, 15);
    expect(tight.tokens).toBeLessThanOrEqual(15);
    expect(tight.included.length).toBeLessThan(3);

    store.close();
  });
});
