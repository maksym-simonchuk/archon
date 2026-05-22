import { describe, expect, it } from 'vitest';
import type { MemoryRecord } from '../core/types';
import { PromotionEngine } from './promotion';
import { MemoryStore } from './store';
import { embedText } from './vector-index';

const rec = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id,
  tier: 'episodic',
  key: 'auth',
  content: `c-${id}`,
  createdAt: '2026-05-21T00:00:00.000Z',
  ...over,
});

describe('MemoryStore (M5)', () => {
  it('recalls pinned ADRs before ordinary records', () => {
    const m = new MemoryStore(':memory:');
    m.write(rec('r1', { tier: 'semantic' }));
    m.write(rec('adr', { tier: 'semantic', content: 'ADR-0003' }), { pinned: true });
    expect(m.recall('semantic', 'auth')[0].id).toBe('adr');
    m.close();
  });

  it('evicts the lowest-value unpinned records but never pinned ones', () => {
    const m = new MemoryStore(':memory:');
    m.write(rec('a'));
    m.write(rec('b'));
    m.write(rec('pinned'), { pinned: true });
    expect(m.evict('episodic', 1)).toBe(1); // keep top 1 unpinned ⇒ drop 1
    expect(m.get('pinned')).toBeDefined();
    m.close();
  });

  it('persists a content vector per record when an embedder is attached (M24)', () => {
    const m = new MemoryStore(':memory:', embedText);
    m.write(rec('a', { content: 'auth login refactor' }));
    const vecs = m.recallVectors('episodic', 'auth');
    expect(vecs).toHaveLength(1);
    expect([...vecs[0].vector]).toEqual([...embedText('auth login refactor')]);
    m.close();
  });

  it('drops a record\'s persisted vector when it is evicted (index stays in step)', () => {
    const m = new MemoryStore(':memory:', embedText);
    m.write(rec('a', { content: 'one' }));
    m.write(rec('b', { content: 'two' }));
    m.evict('episodic', 1); // drop the lowest-value unpinned record
    expect(m.recallVectors('episodic', 'auth')).toHaveLength(1);
    m.close();
  });

  it('omits records that have no persisted vector (written without an embedder)', () => {
    const m = new MemoryStore(':memory:'); // no embedder
    m.write(rec('a'));
    expect(m.recallVectors('episodic', 'auth')).toEqual([]);
    m.close();
  });
});

describe('PromotionEngine (M5)', () => {
  it('proposes candidates but never promotes without an explicit confirm', async () => {
    const m = new MemoryStore(':memory:');
    m.write(rec('p'));
    m.recall('episodic', 'auth'); // freq → 1
    m.recall('episodic', 'auth'); // freq → 2
    m.recall('episodic', 'auth'); // freq → 3
    m.recordSuccess('p');
    m.recordSuccess('p'); // success → 2
    const promo = new PromotionEngine(m);

    const candidates = await promo.propose();
    expect(candidates.map((c) => c.id)).toContain('p');
    expect(m.get('p')?.tier).toBe('episodic'); // propose() promoted nothing

    expect(await promo.confirm('p')).toBe('semantic');
    expect(m.get('p')?.tier).toBe('semantic');
    expect(m.get('p')?.confirmed).toBe(true);
    m.close();
  });

  it('does not propose records below the frequency/success bar', async () => {
    const m = new MemoryStore(':memory:');
    m.write(rec('cold'));
    m.recall('episodic', 'auth'); // freq 1, success 0 — below bar
    const promo = new PromotionEngine(m);
    expect(await promo.propose()).toHaveLength(0);
    m.close();
  });
});
