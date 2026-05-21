import { notImplemented } from './result';

/**
 * Typed facade over the Rust compute core (compiled to WASM — see ADR-0011 and
 * `crates/archon-core`). Pure compute: the host passes bytes, the core returns
 * data. The WASM sandbox cannot perform I/O, which preserves Archon's
 * zero-ambient-authority model — all side effects stay in the TS host, behind
 * the Capability Broker.
 */
export interface ComputeCore {
  /** Merkle leaf hashes for a batch of file contents. */
  hashFiles(files: { path: string; bytes: Uint8Array }[]): Promise<{ path: string; hash: string }[]>;
  /** tree-sitter parse -> symbol-graph delta for one file. */
  parseSymbols(lang: string, source: Uint8Array): Promise<unknown>;
  /** PageRank ranking of the repo-map import/call graph. */
  rankRepoMap(graph: unknown): Promise<unknown>;
  /** Top-k cosine similarity over an embedding matrix (memory retrieval). */
  cosineTopK(query: Float32Array, matrix: Float32Array, dim: number, k: number): Promise<number[]>;
}

/**
 * Loads + instantiates the compiled WASM module once and returns the facade.
 * At M1 this will `await import('../../crates/archon-core/pkg/archon_core.js')`
 * and wrap the wasm-bindgen exports; until then it is a scaffold stub.
 */
export async function loadComputeCore(): Promise<ComputeCore> {
  return notImplemented('loadComputeCore (Rust/WASM core)', 'M1');
}
