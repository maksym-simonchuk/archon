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

  it('falls back to a global repo map when the goal names nothing in the index', async () => {
    const core = await loadComputeCore();
    const store = new IndexStore(':memory:');
    seed(store); // symbols a/b/c — 'understand auth' matches none
    const svc = new ContextService(core, store);

    const out = await svc.assemble(task, 200);
    expect(out.scope).toBeNull();
    expect(out.text.startsWith('# Repo map for: understand auth')).toBe(true);

    store.close();
  });

  it('scopes to the bounded context + impact surface when the goal names code', async () => {
    const core = await loadComputeCore();
    const store = new IndexStore(':memory:');
    // auth/login.ts calls session/store.ts; billing is unrelated.
    store.replaceFileGraph('auth/login.ts', [{ name: 'auth/login.ts#login', kind: 'function' }], [
      { src: 'auth/login.ts#login', dst: 'session/store.ts#open', kind: 'calls' },
    ]);
    store.replaceFileGraph('session/store.ts', [{ name: 'session/store.ts#open', kind: 'function' }], []);
    store.replaceFileGraph('billing/charge.ts', [{ name: 'billing/charge.ts#charge', kind: 'function' }], []);
    store.replaceFileImports('auth/login.ts', ['session/store.ts']);
    for (const [f, h] of [['auth/login.ts', 'h1'], ['session/store.ts', 'h2'], ['billing/charge.ts', 'h3']]) {
      store.upsertFileHash(f, h);
    }
    const svc = new ContextService(core, store);

    const scoped: Task = { id: 't2', goal: 'fix the login flow', profile: 'safe', createdAt: '2026-05-22' };
    const out = await svc.assemble(scoped, 400);

    expect(out.scope).not.toBeNull();
    expect(out.scope?.matchedTerms).toEqual(['login']);
    expect(out.scope?.boundedContext).toEqual(['auth', 'session']); // import-neighbor pulled in
    expect(out.scope?.impactSurface).toBeGreaterThan(0); // blast radius of the seed
    expect(out.text.startsWith('# Context for: fix the login flow')).toBe(true);
    expect(out.text).toContain('bounded context: auth, session');
    // in-scope symbols (auth + session) render first; unrelated billing trails.
    expect(out.included.slice(0, 2).sort()).toEqual(['auth/login.ts#login', 'session/store.ts#open']);
    expect(out.included.indexOf('billing/charge.ts#charge')).toBe(out.included.length - 1);

    store.close();
  });
});
