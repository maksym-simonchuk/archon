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

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

// ── hash_files (M1) ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct HashInput {
    path: String,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
struct FileHashOut {
    path: String,
    hash: String,
}

/// Content-hash a batch of file contents (blake3 Merkle leaf hashes).
/// Input JSON: `[{ "path": string, "bytes": number[] }]`.
/// Output JSON: `[{ "path": string, "hash": string }]` (hash = blake3 hex).
#[wasm_bindgen]
pub fn hash_files(files_json: &str) -> String {
    let inputs: Vec<HashInput> = serde_json::from_str(files_json).unwrap_or_default();
    let out: Vec<FileHashOut> = inputs
        .into_iter()
        .map(|f| FileHashOut {
            hash: blake3::hash(&f.bytes).to_hex().to_string(),
            path: f.path,
        })
        .collect();
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".to_string())
}

// ── parse_symbols (M1) ──────────────────────────────────────────────────────

#[derive(Serialize)]
struct SymbolOut {
    name: String,
    kind: String,
}

#[derive(Serialize)]
struct EdgeOut {
    src: String,
    dst: String,
    kind: String,
}

#[derive(Serialize, Default)]
struct ParsedFileOut {
    symbols: Vec<SymbolOut>,
    edges: Vec<EdgeOut>,
}

const EMPTY_PARSE: &str = "{\"symbols\":[],\"edges\":[]}";

/// Parse one source file into a symbol-graph delta (qualified defines +
/// intra-file `calls` edges). M1 uses a pure-Rust heuristic extractor rather
/// than tree-sitter, whose C grammars do not link cleanly for
/// wasm32-unknown-unknown via wasm-pack (see ADR-0011). Symbol ids are
/// qualified as `path#name` so they are unique across the repo.
#[wasm_bindgen]
pub fn parse_symbols(lang: &str, path: &str, source: &[u8]) -> String {
    let src = match std::str::from_utf8(source) {
        Ok(s) => s,
        Err(_) => return EMPTY_PARSE.to_string(),
    };
    serde_json::to_string(&extract(lang, path, src)).unwrap_or_else(|_| EMPTY_PARSE.to_string())
}

struct Def {
    name: String,
    start: usize,
}

fn extract(lang: &str, path: &str, src: &str) -> ParsedFileOut {
    let mut out = ParsedFileOut::default();
    if !matches!(lang, "typescript" | "javascript") {
        return out; // M1 heuristics cover TS/JS only.
    }

    let def_re = regex::Regex::new(
        r"(?m)^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(?P<fn>[A-Za-z_$][\w$]*)|class\s+(?P<cls>[A-Za-z_$][\w$]*)|(?:const|let|var)\s+(?P<bind>[A-Za-z_$][\w$]*)\s*=)",
    )
    .expect("valid def regex");

    let mut defs: Vec<Def> = Vec::new();
    for caps in def_re.captures_iter(src) {
        let (name, kind) = if let Some(m) = caps.name("fn") {
            (m.as_str(), "function")
        } else if let Some(m) = caps.name("cls") {
            (m.as_str(), "class")
        } else if let Some(m) = caps.name("bind") {
            (m.as_str(), "binding")
        } else {
            continue;
        };
        let start = caps.get(0).map(|m| m.start()).unwrap_or(0);
        out.symbols.push(SymbolOut {
            name: format!("{path}#{name}"),
            kind: kind.to_string(),
        });
        defs.push(Def {
            name: name.to_string(),
            start,
        });
    }

    // Intra-file call edges: scan each def's body (up to the next def) for calls
    // to OTHER local defs. Cross-file edge resolution is deferred (needs the
    // whole-repo graph; see ROADMAP M2).
    let local: HashSet<&str> = defs.iter().map(|d| d.name.as_str()).collect();
    let call_re = regex::Regex::new(r"([A-Za-z_$][\w$]*)\s*\(").expect("valid call regex");

    for (i, d) in defs.iter().enumerate() {
        let body_end = defs.get(i + 1).map(|n| n.start).unwrap_or(src.len());
        let body = &src[d.start..body_end];
        let mut seen: HashSet<&str> = HashSet::new();
        for caps in call_re.captures_iter(body) {
            let callee = match caps.get(1) {
                Some(m) => m.as_str(),
                None => continue,
            };
            if callee == d.name {
                continue; // the definition token itself
            }
            if local.contains(callee) && seen.insert(callee) {
                out.edges.push(EdgeOut {
                    src: format!("{path}#{}", d.name),
                    dst: format!("{path}#{callee}"),
                    kind: "calls".to_string(),
                });
            }
        }
    }
    out
}

// ── deferred kernels ────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct RankEdge {
    src: String,
    dst: String,
}

#[derive(Deserialize)]
struct RankInput {
    nodes: Vec<String>,
    edges: Vec<RankEdge>,
}

#[derive(Serialize)]
struct RankedNode {
    id: String,
    score: f64,
}

/// Rank the repo-map by PageRank over the symbol import/call graph (M2).
/// Input JSON: `{ "nodes": string[], "edges": [{ "src", "dst" }] }`.
/// Output JSON: `[{ "id", "score" }]` sorted by score descending. Edges that
/// reference unknown nodes are ignored; dangling nodes (no out-edges)
/// redistribute their rank uniformly so total mass is conserved.
#[wasm_bindgen]
pub fn rank_repo_map(graph_json: &str) -> String {
    let input: RankInput = match serde_json::from_str(graph_json) {
        Ok(g) => g,
        Err(_) => return "[]".to_string(),
    };
    let n = input.nodes.len();
    if n == 0 {
        return "[]".to_string();
    }

    let index: std::collections::HashMap<&str, usize> = input
        .nodes
        .iter()
        .enumerate()
        .map(|(i, s)| (s.as_str(), i))
        .collect();

    let mut out: Vec<Vec<usize>> = vec![Vec::new(); n];
    for e in &input.edges {
        if let (Some(&s), Some(&d)) = (index.get(e.src.as_str()), index.get(e.dst.as_str())) {
            out[s].push(d);
        }
    }

    let damping = 0.85_f64;
    let teleport = (1.0 - damping) / n as f64;
    let mut rank = vec![1.0_f64 / n as f64; n];

    for _ in 0..100 {
        let mut next = vec![teleport; n];
        let mut dangling = 0.0_f64;
        for (i, links) in out.iter().enumerate() {
            if links.is_empty() {
                dangling += rank[i];
            } else {
                let share = damping * rank[i] / links.len() as f64;
                for &j in links {
                    next[j] += share;
                }
            }
        }
        let dangling_share = damping * dangling / n as f64;
        for v in next.iter_mut() {
            *v += dangling_share;
        }
        let delta: f64 = rank.iter().zip(&next).map(|(a, b)| (a - b).abs()).sum();
        rank = next;
        if delta < 1e-9 {
            break;
        }
    }

    let mut ranked: Vec<RankedNode> = input
        .nodes
        .into_iter()
        .enumerate()
        .map(|(i, id)| RankedNode { id, score: rank[i] })
        .collect();
    ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    serde_json::to_string(&ranked).unwrap_or_else(|_| "[]".to_string())
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Top-k cosine similarity for memory / embedding retrieval (M7). `matrix` is a
/// row-major `rows × dim` embedding matrix; returns the row indices of the `k`
/// rows most similar to `query`, highest similarity first. Zero-norm rows score
/// 0 (never NaN); ties keep input order. A zero-norm query or `dim == 0` yields
/// no results. Pure compute — the host owns the vectors and the I/O.
#[wasm_bindgen]
pub fn cosine_topk(query: &[f32], matrix: &[f32], dim: usize, k: usize) -> Vec<u32> {
    if dim == 0 || k == 0 || query.len() < dim {
        return Vec::new();
    }
    let q = &query[..dim];
    let q_norm = dot(q, q).sqrt();
    if q_norm == 0.0 {
        return Vec::new();
    }
    let rows = matrix.len() / dim;
    let mut scored: Vec<(usize, f32)> = (0..rows)
        .map(|i| {
            let row = &matrix[i * dim..(i + 1) * dim];
            let row_norm = dot(row, row).sqrt();
            let sim = if row_norm == 0.0 { 0.0 } else { dot(q, row) / (q_norm * row_norm) };
            (i, sim)
        })
        .collect();
    // Descending by score; stable on ties so equal scores keep input order.
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().take(k.min(rows)).map(|(i, _)| i as u32).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_bytes_hash_identically() {
        let a = hash_files(r#"[{"path":"a.ts","bytes":[97,98,99]}]"#);
        let b = hash_files(r#"[{"path":"b.ts","bytes":[97,98,99]}]"#);
        let ha = a.split("\"hash\":\"").nth(1).unwrap().split('"').next().unwrap();
        let hb = b.split("\"hash\":\"").nth(1).unwrap().split('"').next().unwrap();
        assert_eq!(ha, hb);
        assert_eq!(ha.len(), 64); // blake3 hex
    }

    #[test]
    fn extracts_qualified_defs_and_intra_file_calls() {
        let src = b"export function a() { return b(); }\nfunction b() { return 1; }\n";
        let json = parse_symbols("typescript", "src/x.ts", src);
        assert!(json.contains("src/x.ts#a"));
        assert!(json.contains("src/x.ts#b"));
        assert!(json.contains("\"src\":\"src/x.ts#a\""));
        assert!(json.contains("\"dst\":\"src/x.ts#b\""));
    }

    #[test]
    fn ignores_non_ts_languages() {
        assert_eq!(parse_symbols("rust", "x.rs", b"fn a() {}"), EMPTY_PARSE);
    }

    #[test]
    fn pagerank_ranks_the_hub_highest() {
        // a -> c, b -> c : c has the most incoming links, so it ranks first.
        let g = r#"{"nodes":["a","b","c"],"edges":[{"src":"a","dst":"c"},{"src":"b","dst":"c"}]}"#;
        assert!(rank_repo_map(g).starts_with("[{\"id\":\"c\""));
    }

    #[test]
    fn pagerank_empty_graph_is_empty() {
        assert_eq!(rank_repo_map(r#"{"nodes":[],"edges":[]}"#), "[]");
    }

    #[test]
    fn cosine_topk_ranks_nearest_rows_first() {
        // dim 2, three rows: row0 == query, row2 anti-parallel, row1 orthogonal.
        let query = [1.0_f32, 0.0];
        let matrix = [1.0_f32, 0.0, /* r0 */ 0.0, 1.0, /* r1 */ -1.0, 0.0 /* r2 */];
        assert_eq!(cosine_topk(&query, &matrix, 2, 2), vec![0, 1]);
        assert_eq!(cosine_topk(&query, &matrix, 2, 1), vec![0]);
    }

    #[test]
    fn cosine_topk_handles_zero_norm_and_empty() {
        let query = [0.0_f32, 0.0];
        assert!(cosine_topk(&query, &[1.0, 0.0], 2, 1).is_empty()); // zero-norm query
        assert!(cosine_topk(&[1.0, 0.0], &[1.0, 0.0], 2, 0).is_empty()); // k == 0
    }
}
