//! archon-core — CPU-bound compute kernels for Archon, compiled to WebAssembly.
//!
//! Pure functions only: bytes in -> data out. This crate performs NO file,
//! network, or process I/O. The TypeScript host owns all side effects (routed
//! through the Capability Broker) and feeds this module the bytes it needs.
//! That keeps the hot path fast AND preserves Archon's zero-ambient-authority
//! safety model (the WASM sandbox simply cannot reach the OS). See ADR-0011.
//!
//! Boundary discipline: keep crossings coarse — pass large buffers, return
//! batched results. The JS<->WASM copy cost dominates if calls are chatty.

use wasm_bindgen::prelude::*;

/// Content-hash a batch of file contents (Merkle leaf hashes).
/// JSON in/out gives a stable, language-agnostic boundary; switch to a
/// zero-copy format (e.g. bincode over `&[u8]`) if profiling demands it.
#[wasm_bindgen]
pub fn hash_files(_files_json: &str) -> String {
    unimplemented!("archon-core::hash_files — see docs/ROADMAP.md (M1)")
}

/// Parse source bytes into symbol-graph deltas (defines/imports/calls/tests)
/// via tree-sitter. `lang` selects the grammar.
#[wasm_bindgen]
pub fn parse_symbols(_lang: &str, _source: &[u8]) -> String {
    unimplemented!("archon-core::parse_symbols — see docs/ROADMAP.md (M1)")
}

/// Rank the repo-map by PageRank over the import/call graph.
#[wasm_bindgen]
pub fn rank_repo_map(_graph_json: &str) -> String {
    unimplemented!("archon-core::rank_repo_map — see docs/ROADMAP.md (M2)")
}

/// Top-k cosine similarity for memory / embedding retrieval (SIMD-friendly).
#[wasm_bindgen]
pub fn cosine_topk(_query: &[f32], _matrix: &[f32], _dim: usize, _k: usize) -> Vec<u32> {
    unimplemented!("archon-core::cosine_topk — see docs/ROADMAP.md (M7)")
}
