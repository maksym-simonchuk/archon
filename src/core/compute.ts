import type { FileHash, ParsedFile, RankedSymbol, RepoMapInput } from './types';

/**
 * Typed facade over the Rust compute core (compiled to WASM — see ADR-0011 and
 * `crates/archon-core`). Pure compute: the host passes bytes, the core returns
 * data. The WASM sandbox cannot perform I/O, which preserves Archon's
 * zero-ambient-authority model — all side effects stay in the TS host, behind
 * the Capability Broker.
 */
export interface ComputeCore {
  /** Merkle leaf hashes for a batch of file contents. */
  hashFiles(files: { path: string; bytes: Uint8Array }[]): Promise<FileHash[]>;
  /**
   * tree-sitter parse -> symbol-graph delta for one file. `path` is the repo-
   * relative source path; the core uses it to emit repo-unique qualified symbol
   * ids and to resolve relative import/test edges.
   */
  parseSymbols(lang: string, path: string, source: Uint8Array): Promise<ParsedFile>;
  /** PageRank ranking of the repo-map import/call graph (ADR-0006). */
  rankRepoMap(graph: RepoMapInput): Promise<RankedSymbol[]>;
  /**
   * Top-k cosine similarity over a row-major `rows × dim` embedding matrix
   * (memory / embedding retrieval). Resolves to the row indices of the `k` most
   * similar rows, highest similarity first.
   */
  cosineTopK(query: Float32Array, matrix: Float32Array, dim: number, k: number): Promise<number[]>;
}

/**
 * Loads the compiled WASM module (`wasm-pack build --target nodejs` → `pkg/`)
 * and wraps the wasm-bindgen exports behind the typed facade. The boundary is
 * JSON for the graph kernels (the host marshals inputs, the core returns JSON
 * strings parsed back into `FileHash` / `ParsedFile`); `cosineTopK` passes typed
 * arrays straight through, since wasm-bindgen maps `&[f32]` / `Vec<u32>` to
 * `Float32Array` / `Uint32Array` with no copy on the JSON path.
 *
 * Requires `npm run build:wasm` to have produced `pkg/` (typecheck resolves the
 * generated `archon_core.d.ts`).
 */
export async function loadComputeCore(): Promise<ComputeCore> {
  const wasm = await import('../../crates/archon-core/pkg/archon_core.js');
  return {
    hashFiles: async (files) =>
      JSON.parse(
        wasm.hash_files(JSON.stringify(files.map((f) => ({ path: f.path, bytes: Array.from(f.bytes) })))),
      ) as FileHash[],
    parseSymbols: async (lang, path, source) =>
      JSON.parse(wasm.parse_symbols(lang, path, source)) as ParsedFile,
    rankRepoMap: async (graph) => JSON.parse(wasm.rank_repo_map(JSON.stringify(graph))) as RankedSymbol[],
    cosineTopK: async (query, matrix, dim, k) =>
      Array.from(wasm.cosine_topk(query, matrix, dim, k)),
  };
}
