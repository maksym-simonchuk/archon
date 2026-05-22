import type { ComputeCore } from '../../core/compute';
import type { MemoryTier } from '../../core/types';
import type { MemoryStore } from '../../memory/store';
import type { RetrieverPlugin } from '../abi';

/** Hashed-embedding width. Small + fixed so the matrix stays cache-friendly. */
const DIM = 64;

/**
 * Built-in `retriever` plugin: semantically reranks the memory records filed
 * under one `(tier, key)` anchor against a query, using the Rust/WASM
 * `embedTopK` kernel — which tokenizes, hashes, and ranks in a single coarse
 * crossing (the per-token embedding work formerly done on the host now lives in
 * the core; see ADR-0011). It is pure compute over records already in memory —
 * it touches no fs / exec / net — so its manifest declares **no** capabilities
 * and the broker grants it nothing. This is the minimal end-to-end demonstration
 * of the embedding path (host → WASM core) shipped as an ABI v0 plugin (ADR-0009).
 */
export function createEmbeddingRetriever(
  core: ComputeCore,
  memory: MemoryStore,
  tier: MemoryTier,
  key: string,
): RetrieverPlugin {
  return {
    kind: 'retriever',
    manifest: { name: 'embedding-retriever', version: '0.0.0', kind: 'retriever', capabilities: [] },

    async retrieve(query: string, k: number): Promise<string[]> {
      const records = memory.recall(tier, key);
      if (records.length === 0 || k <= 0) return [];

      const top = await core.embedTopK(
        query,
        records.map((r) => r.content),
        DIM,
        Math.min(k, records.length),
      );
      return top.map((i) => records[i].content);
    },
  };
}
