# 0011 — Rust → WASM compute core for hot paths

- Status: accepted
- Date: 2026-05-21
- Deciders: Archon core, Execution, Safety

## Context

The highest-cost *compute* in Archon is CPU-bound and runs constantly: content
hashing (Merkle), tree-sitter parsing + symbol-graph construction, repo-map
ranking (PageRank), and vector top-k for retrieval. In Node these are slow and
GC-heavy at repo scale. (Note: LLM calls are the dominant *dollar* cost, but they
are I/O/network-bound — not a CPU problem, so they stay in TS.)

Requirement (stakeholder): the highest-cost tasks must be **written and executed
in Rust**, bridged to TypeScript **via WASM**.

## Decision

Implement the CPU-bound kernels in a **Rust crate (`crates/archon-core`)** compiled
to **WebAssembly** with `wasm-bindgen` (`wasm-pack build --target nodejs`). The TS
host loads it once via `src/core/compute.ts` and uses it behind the typed
`ComputeCore` facade. Exposed kernels: `hash_files`, `parse_symbols`,
`rank_repo_map`, `cosine_topk`.

Scope is deliberately narrow: **only** the Sensing kernels + memory vector ops.
Orchestration, LLM routing, git/fs I/O, policy, and the journal **stay in
TypeScript** — they are I/O-bound and live in the JS ecosystem.

The Rust core is **pure**: bytes in, data out, **no file/network/process I/O**.
The TS host feeds it bytes (obtained through the Capability Broker) and consumes
results.

## Consequences

- Positive: native-class speed on the genuine hot path; one portable artifact (Node/edge/browser); the WASM sandbox has **no ambient authority**, so it *reinforces* the broker safety model (ADR-0003).
- Cost: adds a Rust toolchain + `wasm-pack` to the build; a JS↔WASM boundary copy cost — mitigated by **coarse, batched calls with large buffers**; two languages to maintain.
- Risk removed: CPU/GC bottleneck at scale; and (vs a native addon) a side channel that could bypass the broker.

## M1 implementation note (2026-05-21)

`parse_symbols` ships in M1 as a **pure-Rust heuristic extractor**, not tree-sitter.
tree-sitter's grammars are C and do not link cleanly when the crate is compiled to
`wasm32-unknown-unknown` via `wasm-pack` (no libc; the C runtime + generated parsers
fight the bare target). To keep the compute core a single sandboxed WASM artifact
(the whole point of this ADR), M1 extracts top-level definitions and intra-file
`calls` edges with `regex` over the source. This is lossier than a real parse
(no scope/type awareness, intra-file edges only) but is enough for the M1 exit
criteria (incremental reparse + `blastRadius()`), and it keeps the zero-ambient-authority
guarantee intact. Upgrading to a true parse — either tree-sitter compiled to
`wasm32-wasi`, or `web-tree-sitter` run in the TS host and fed across the boundary —
is tracked as future work; the `ComputeCore.parseSymbols` facade does not change.
`hash_files` (blake3), `rank_repo_map` (M2), and `cosine_topk` (M7) are unaffected.

## Alternatives considered

- **Pure TypeScript** — rejected: too slow / GC-heavy for parse + rank + vector at repo scale.
- **Native N-API addon (napi-rs)** — faster still, with threads/SIMD/FS, but ships per-platform binaries **and can touch the filesystem directly, bypassing the Capability Broker**. Rejected in favour of the sandboxed WASM boundary (safety > marginal speed).
- **Rewrite everything in Rust** — rejected: orchestration/LLM is I/O-bound; Rust adds no value there and forfeits the JS LLM/git SDK ecosystem (anti-overengineering).
