# ROADMAP — Implementing Archon

Build order = the pragmatic vertical slice from [`ARCHITECTURE.md`](ARCHITECTURE.md).
**Implement each milestone following [`AGENTS.md`](../AGENTS.md)** (design → minimal diff
→ verify). One milestone ≈ one reviewable branch; each fills in stubs already scaffolded
under `src/` (and `crates/` for the Rust core).

Toolchain: **Node ≥ 20** (host) + **Rust stable & `wasm-pack`** (compute core, ADR-0011).

Legend: ✅ done · ⬜ todo

## M0 — Foundations ✅ (this scaffold)
- Goal: repo skeleton, contracts, governance, safety policy, CLI surface, Rust/WASM boundary.
- Built: `src/core/{types,result,compute}.ts`, all plane/service stubs, `crates/archon-core` (stub kernels), `AGENTS.md`, `.archon/policy.yaml`, ADRs 0001–0011, this roadmap.
- Exit: `npm run typecheck` passes; `npm run dev -- --help` prints the command surface. ✅

## M1 — Sensing: incremental index + Rust/WASM core ⬜
- Goal: never full-rescan; structural substrate; the hot kernels live in Rust.
- Build (Rust): `crates/archon-core` `hash_files` (blake3 Merkle), `parse_symbols` (tree-sitter). `npm run build:wasm` → `pkg/`.
- Build (TS): `core/compute.ts` `loadComputeCore()` wraps the wasm exports; `sensing/indexer.ts` (git-diff dirty paths, hashes via core, persist to SQLite); `sensing/symbol-graph.ts` (graph edges; `blastRadius()` via reachability).
- Deps: wasm-bindgen, blake3, tree-sitter(+grammars), better-sqlite3, simple-git. Depends: M0.
- ADRs: 0005, 0011. Exit: editing 1 file reparses only that subtree (via core); `blastRadius()` returns reachable files/symbols; `loadComputeCore()` resolves.

## M2 — Sensing: context service ⬜
- Goal: compression, not ingestion; token-budgeted working set.
- Build (Rust): `rank_repo_map` (PageRank). Build (TS): `sensing/context-service.ts` — repo-map, hash-keyed summaries (`.archon/cache`), budgeted assembly with lowest-rank drop + provenance.
- Deps: M1. ADRs: 0006, 0011. Exit: `assemble(task,budget)` never exceeds budget; identical repo state → cache hit (no recompute).

## M3 — Effecting: safety core ⬜
- Goal: single choke point; default-deny; auditable.
- Build: `effecting/policy-engine.ts` (load `.archon/policy.yaml`, evaluate action×target×blastRadius), `effecting/capability-broker.ts` (mediate fs/exec/net/secret; nothing bypasses it), `effecting/audit-log.ts`.
- Deps: M1 (blast radius). ADRs: 0003, 0010. Exit: unit tests prove deny (force-push, secret read), ask (>5 files), allow (in-scope write); the broker is the only module importing `fs`/`child_process` in agent paths.

## M4 — Effecting: transactions ⬜
- Goal: reversible by default.
- Build: `effecting/transaction.ts` — git worktree per risky task, commit micro-steps, run Verifier, merge on green / discard on fail.
- Deps: M3. ADRs: 0004. Exit: a failed verify leaves the main working tree untouched; a successful task is a clean commit series.

## M5 — Memory ⬜
- Goal: long-term memory + safe evolution.
- Build: `memory/store.ts` (3 tiers in SQLite, content-hash keys, decay/eviction), `memory/promotion.ts` (propose on frequency+success; `confirm()` gate).
- Deps: M3. ADRs: 0008. Exit: promotion never auto-applies; recall returns pinned ADRs first.

## M6 — Cognition loop ⬜
- Goal: the load-bearing primitive, end-to-end.
- Build: `cognition/{planner,executor,verifier,reflector,loop}.ts`; wire `archon plan <goal>` (dry-run, no writes) and `archon run <goal>` (safe profile, worktree, verify).
- Deps: M2, M3, M4, M5, M7-router(min). ADRs: 0002. Exit: `archon plan` prints a plan tree of reversible steps; `archon run` executes one trivial task (add a function + test) and self-verifies.

## M7 — Provider router + plugins ⬜
- Goal: multi-provider + extensibility.
- Build: `services/provider-router.ts` (registry, task-class routing, prompt cache, fallback, budget breaker), `services/plugin-host.ts` (load ABI v0, enforce declared capabilities via broker). Rust: `cosine_topk` for the embeddings retriever. Ship embeddings + LSP as plugins.
- Deps: M3. ADRs: 0007, 0009, 0011. Exit: a provider outage falls back without task failure; a sample tool plugin runs only with its declared capabilities.

## Cross-cutting (every milestone)
- Tests live beside the milestone; `npm run typecheck` green before merge.
- Update the relevant ADR if a decision changes (status → superseded).
- Emit journal entries for plan / step / decision / diff / verdict / cost.
