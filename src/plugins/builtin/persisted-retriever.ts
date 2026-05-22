import type { ComputeCore } from '../../core/compute';
import type { MemoryTier } from '../../core/types';
import type { MemoryStore } from '../../memory/store';
import { DEFAULT_DIM, embedText } from '../../memory/vector-index';
import type { RetrieverPlugin } from '../abi';

/**
 * Built-in `retriever` plugin backed by the **persisted** vector index (M24).
 * Where {@link createEmbeddingRetriever} re-embeds every candidate on each query
 * (via the WASM `embedTopK`), this reads the embeddings the {@link MemoryStore}
 * already stored at write time and ranks the query against that matrix with the
 * core's `cosineTopK` kernel — so recall cost no longer scales with document
 * length, only with the (small) candidate count. The query is embedded with the
 * same deterministic embedding the store used, so the two vectors share a space.
 *
 * Pure compute over records already in memory — no fs / exec / net — so its
 * manifest declares no capabilities and the broker grants it nothing. If no
 * record under the anchor has a stored vector (e.g. memory written before an
 * embedder was attached), it returns nothing rather than guessing.
 */
export function createPersistedRetriever(
  core: ComputeCore,
  memory: MemoryStore,
  tier: MemoryTier,
  key: string,
  dim: number = DEFAULT_DIM,
): RetrieverPlugin {
  return {
    kind: 'retriever',
    manifest: { name: 'persisted-retriever', version: '0.0.0', kind: 'retriever', capabilities: [] },

    async retrieve(query: string, k: number): Promise<string[]> {
      const records = memory.recallVectors(tier, key);
      if (records.length === 0 || k <= 0) return [];

      // Stack the stored vectors row-major into one `rows × dim` matrix for the
      // core's cosine kernel (it ranks the query against every row at once).
      const matrix = new Float32Array(records.length * dim);
      records.forEach((r, i) => matrix.set(r.vector, i * dim));

      const top = await core.cosineTopK(embedText(query, dim), matrix, dim, Math.min(k, records.length));
      return top.map((i) => records[i].content);
    },
  };
}
