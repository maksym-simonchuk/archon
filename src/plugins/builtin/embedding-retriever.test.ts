import { describe, expect, it } from 'vitest';
import { loadComputeCore } from '../../core/compute';
import type { MemoryRecord } from '../../core/types';
import { MemoryStore } from '../../memory/store';
import { createEmbeddingRetriever } from './embedding-retriever';

const rec = (id: string, key: string, content: string): MemoryRecord => ({
  id,
  tier: 'semantic',
  key,
  content,
  createdAt: '2026-01-01T00:00:00Z',
});

// Exercises the REAL Rust/WASM cosineTopK kernel (requires `npm run build:wasm`).
describe('embedding-retriever (built-in plugin)', () => {
  it('declares no capabilities — it is pure compute', async () => {
    const core = await loadComputeCore();
    const memory = new MemoryStore(':memory:');
    try {
      const r = createEmbeddingRetriever(core, memory, 'semantic', 'k');
      expect(r.kind).toBe('retriever');
      expect(r.manifest.capabilities).toEqual([]);
    } finally {
      memory.close();
    }
  });

  it('ranks the records under an anchor by similarity to the query', async () => {
    const core = await loadComputeCore();
    const memory = new MemoryStore(':memory:');
    try {
      memory.write(rec('m1', 'k', 'database sqlite storage persistence durable'));
      memory.write(rec('m2', 'k', 'network http request latency retries'));
      memory.write(rec('m3', 'k', 'rust wasm compute kernel pure'));

      const r = createEmbeddingRetriever(core, memory, 'semantic', 'k');
      const top = await r.retrieve('sqlite database persistence layer', 2);

      expect(top).toHaveLength(2);
      expect(top[0]).toBe('database sqlite storage persistence durable');
    } finally {
      memory.close();
    }
  });

  it('returns [] for an empty anchor or non-positive k', async () => {
    const core = await loadComputeCore();
    const memory = new MemoryStore(':memory:');
    try {
      const r = createEmbeddingRetriever(core, memory, 'semantic', 'missing');
      expect(await r.retrieve('anything', 3)).toEqual([]);

      memory.write(rec('m1', 'k', 'present'));
      const r2 = createEmbeddingRetriever(core, memory, 'semantic', 'k');
      expect(await r2.retrieve('present', 0)).toEqual([]);
    } finally {
      memory.close();
    }
  });
});
