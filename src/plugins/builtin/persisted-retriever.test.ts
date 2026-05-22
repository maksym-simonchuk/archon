import { describe, expect, it } from 'vitest';
import type { ComputeCore } from '../../core/compute';
import type { MemoryRecord } from '../../core/types';
import { MemoryStore } from '../../memory/store';
import { embedText } from '../../memory/vector-index';
import { createPersistedRetriever } from './persisted-retriever';

/** A real cosineTopK over the host-built matrix, so the test asserts true ranking
 *  (the other kernels are unused by the retriever). */
const cosineCore = (): ComputeCore => ({
  hashFiles: async () => [],
  parseSymbols: async () => ({ symbols: [], edges: [] }),
  rankRepoMap: async () => [],
  embedTopK: async () => [],
  fuzzyRank: async () => [],
  cosineTopK: async (query, matrix, dim, k) => {
    const rows = matrix.length / dim;
    const scored: { i: number; s: number }[] = [];
    for (let i = 0; i < rows; i++) {
      let s = 0;
      for (let d = 0; d < dim; d++) s += query[d] * matrix[i * dim + d];
      scored.push({ i, s });
    }
    return scored
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.i);
  },
});

const rec = (id: string, content: string): MemoryRecord => ({
  id,
  tier: 'episodic',
  key: 'goal',
  content,
  createdAt: new Date().toISOString(),
});

describe('createPersistedRetriever', () => {
  it('ranks stored vectors against the query, most similar first', async () => {
    const memory = new MemoryStore(':memory:', embedText);
    memory.write(rec('a', 'refactor the auth login flow'));
    memory.write(rec('b', 'database migration rollback schema'));
    memory.write(rec('c', 'auth login session refactor'));

    const retriever = createPersistedRetriever(cosineCore(), memory, 'episodic', 'goal');
    const hits = await retriever.retrieve('auth login refactor', 2);

    expect(hits).toHaveLength(2);
    expect(hits).not.toContain('database migration rollback schema');
    memory.close();
  });

  it('returns nothing when the anchor has no records (or k <= 0)', async () => {
    const memory = new MemoryStore(':memory:', embedText);
    const retriever = createPersistedRetriever(cosineCore(), memory, 'episodic', 'goal');
    expect(await retriever.retrieve('anything', 3)).toEqual([]);
    memory.write(rec('a', 'something'));
    expect(await retriever.retrieve('anything', 0)).toEqual([]);
    memory.close();
  });

  it('omits records written without an embedder (no persisted vector)', async () => {
    const memory = new MemoryStore(':memory:'); // no embedder → no vectors stored
    memory.write(rec('a', 'refactor the auth login flow'));
    const retriever = createPersistedRetriever(cosineCore(), memory, 'episodic', 'goal');
    expect(await retriever.retrieve('auth login', 3)).toEqual([]);
    memory.close();
  });
});
