/**
 * Deterministic hashing-trick text embedding + (de)serialization for the
 * persisted vector index (M24). Embeddings are computed once on write and stored
 * alongside each memory record (see {@link MemoryStore}), so semantic recall
 * ranks a query against the *stored* matrix — `O(records)` cosine — instead of
 * re-embedding every document on every query (the old `embedTopK` path).
 *
 * The embedding is the same family the Rust core's `embed_topk` uses (tokenize →
 * FNV-1a hash → fixed-width bucket → L2-normalize), reimplemented in pure TS so
 * the persisted vectors do not depend on the WASM build being present, and so a
 * stored vector and a freshly-embedded query are guaranteed to share one space.
 * Determinism is the contract: the same text always yields the same vector, so a
 * persisted vector stays valid until its record's content changes.
 */

/** Embedding width. Fixed + small so the per-record blob and the query matrix
 *  stay cache-friendly; matches the retriever's expectation. */
export const DEFAULT_DIM = 64;

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** FNV-1a over a token's UTF-16 code units → an unsigned 32-bit bucket seed. */
function fnv1a(token: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/** Lowercase alphanumeric tokens; everything else is a separator. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Embed `text` into a unit-length `dim`-vector via the hashing trick: each token
 * increments its hashed bucket, then the vector is L2-normalized so cosine
 * similarity reduces to a dot product. Empty / token-less text yields the zero
 * vector (cosine 0 against everything — it simply never ranks).
 */
export function embedText(text: string, dim: number = DEFAULT_DIM): Float32Array {
  const v = new Float32Array(dim);
  for (const tok of tokenize(text)) v[fnv1a(tok) % dim] += 1;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < dim; i++) v[i] *= inv;
  }
  return v;
}

/** Pack a vector into a little-endian Float32 blob for SQLite BLOB storage. */
export function packVector(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
}

/** Unpack a stored blob back into a Float32Array (copies into an aligned buffer,
 *  since a SQLite blob's backing buffer is not guaranteed 4-byte aligned). */
export function unpackVector(blob: Uint8Array): Float32Array {
  const aligned = blob.slice();
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
}
