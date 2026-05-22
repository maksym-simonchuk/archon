import type { ComputeCore } from '../../core/compute';
import type { MemoryTier } from '../../core/types';
import type { MemoryStore } from '../../memory/store';
import type { RetrieverPlugin } from '../abi';

/** Hashed-embedding width. Small + fixed so the matrix stays cache-friendly. */
const DIM = 64;

/** FNV-1a 32-bit over the UTF-8 bytes of a token. */
function fnv1a(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic bag-of-tokens embedding via the hashing trick: each token bumps
 * one of `dim` buckets (FNV-1a → bucket). No model, no network, no training —
 * identical text always yields an identical vector, which keeps retrieval
 * reproducible and offline. cosine similarity handles magnitude, so the raw
 * counts need no normalization here.
 */
function embed(text: string, dim: number): Float32Array {
  const vec = new Float32Array(dim);
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token) vec[fnv1a(token) % dim] += 1;
  }
  return vec;
}

/**
 * Built-in `retriever` plugin: semantically reranks the memory records filed
 * under one `(tier, key)` anchor against a query, using the Rust/WASM
 * `cosineTopK` kernel. It is pure compute over records already in memory — it
 * touches no fs / exec / net — so its manifest declares **no** capabilities and
 * the broker grants it nothing. This is the minimal end-to-end demonstration of
 * the embedding path (host → WASM core) shipped as an ABI v0 plugin (ADR-0009).
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

      const queryVec = embed(query, DIM);
      const matrix = new Float32Array(records.length * DIM);
      records.forEach((r, i) => matrix.set(embed(r.content, DIM), i * DIM));

      const top = await core.cosineTopK(queryVec, matrix, DIM, Math.min(k, records.length));
      return top.map((i) => records[i].content);
    },
  };
}
