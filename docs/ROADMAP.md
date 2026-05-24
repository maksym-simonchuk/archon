# ROADMAP — Implementing Archon

Build order = the pragmatic vertical slice from [`ARCHITECTURE.md`](ARCHITECTURE.md).
**Implement each milestone following [`AGENTS.md`](../AGENTS.md)** (design → minimal diff
→ verify). One milestone ≈ one reviewable branch; each fills in stubs already scaffolded
under `src/` (and `crates/` for the Rust core).

Toolchain: **Node ≥ 24** (host; uses built-in `node:sqlite`) + **Rust stable & `wasm-pack`** (compute core, ADR-0011).

## Status (current branch: `feat/runtime-v2-substrate`)

The roadmap is split across three documents — Archon now ships **all three phases**:

| Phase | Milestones | Document | Status |
| --- | --- | --- | --- |
| **Safety + cognition substrate** | M0–M7 | this file | ✅ shipped |
| **Repository intelligence** | M8–M24 | [`ROADMAP-INTELLIGENCE.md`](ROADMAP-INTELLIGENCE.md) | ✅ shipped (merged to `main` via PR #6) |
| **Runtime v2 (realtime UX + open standards)** | M25–M40 | [`RUNTIME-V2.md`](RUNTIME-V2.md) §7 | ✅ shipped on this branch |

Runtime v2 (M25–M40) closes out the Mastra-shaped DAG, OpenSpec, MCP client+server, LSP bridge, OTel exporter, session replay, plugin ABI v1, and TUI cards (`/diff`, `/approve`, `/spec`, `/replay --live`, `/workflow`, `/council`, `/mcp`, `/lsp`). See `RUNTIME-V2.md` §7 for the per-milestone state.

Legend: ✅ done · ⬜ todo

## M0 — Foundations ✅ (this scaffold)
- Goal: repo skeleton, contracts, governance, safety policy, CLI surface, Rust/WASM boundary.
- Built: `src/core/{types,result,compute}.ts`, all plane/service stubs, `crates/archon-core` (stub kernels), `AGENTS.md`, `.archon/policy.yaml`, ADRs 0001–0011, this roadmap.
- Exit: `npm run typecheck` passes; `npm run dev -- --help` prints the command surface. ✅

## M1 — Sensing: incremental index + Rust/WASM core ✅
- Goal: never full-rescan; structural substrate; the hot kernels live in Rust.
- Build (Rust): `crates/archon-core` `hash_files` (blake3 Merkle), `parse_symbols` (pure-Rust heuristic extractor — tree-sitter C grammars don't link to wasm32-unknown-unknown; deferred, see ADR-0011). `npm run build:wasm` → `pkg/`.
- Build (TS): `core/compute.ts` `loadComputeCore()` wraps the wasm exports; `sensing/indexer.ts` (git-diff dirty paths, hashes via core, persist to SQLite); `sensing/symbol-graph.ts` (graph edges; `blastRadius()` via reachability).
- Deps: wasm-bindgen, blake3, serde/serde_json, regex; `node:sqlite` (built-in — not better-sqlite3, needs Node ≥ 24), simple-git. Depends: M0.
- ADRs: 0005, 0011. Exit: editing 1 file reparses only that subtree (via core); `blastRadius()` returns reachable files/symbols; `loadComputeCore()` resolves.

## M2 — Sensing: context service ✅
- Goal: compression, not ingestion; token-budgeted working set.
- Build (Rust): `rank_repo_map` (PageRank). Build (TS): `sensing/context-service.ts` — repo-map, hash-keyed summaries (`.archon/cache`), budgeted assembly with lowest-rank drop + provenance.
- Deps: M1. ADRs: 0006, 0011. Exit: `assemble(task,budget)` never exceeds budget; identical repo state → cache hit (no recompute).

## M3 — Effecting: safety core ✅
- Goal: single choke point; default-deny; auditable.
- Build: `effecting/policy-engine.ts` (load `.archon/policy.yaml`, evaluate action×target×blastRadius), `effecting/capability-broker.ts` (mediate fs/exec/net/secret; nothing bypasses it), `effecting/audit-log.ts`.
- Deps: M1 (blast radius). ADRs: 0003, 0010. Exit: unit tests prove deny (force-push, secret read), ask (>5 files), allow (in-scope write); the broker is the only module importing `fs`/`child_process` in agent paths.

## M4 — Effecting: transactions ✅
- Goal: reversible by default.
- Build: `effecting/transaction.ts` — git worktree per risky task, commit micro-steps, run Verifier, merge on green / discard on fail.
- Deps: M3. ADRs: 0004. Exit: a failed verify leaves the main working tree untouched; a successful task is a clean commit series.

## M5 — Memory ✅
- Goal: long-term memory + safe evolution.
- Build: `memory/store.ts` (3 tiers in SQLite, content-hash keys, decay/eviction), `memory/promotion.ts` (propose on frequency+success; `confirm()` gate).
- Deps: M3. ADRs: 0008. Exit: promotion never auto-applies; recall returns pinned ADRs first.

## M6 — Cognition loop ✅
- Goal: the load-bearing primitive, end-to-end.
- Build: `cognition/{planner,executor,verifier,reflector,loop}.ts`; wire `archon plan <goal>` (dry-run, no writes) and `archon run <goal>` (worktree tx, verify, merge/discard).
- Deps: M2, M3, M4, M5, M7-router(min). ADRs: 0002. Exit: `archon plan` prints a plan tree of reversible steps; `archon run` executes one trivial task (add a function + test) and self-verifies.
- Note: planning is pluggable (`PlanStrategy`). M6 ships a deterministic offline `ScaffoldStrategy` (writes a function + a `node`-run self-test, needing no project deps in the worktree); the LLM-backed planner over the ProviderRouter plugs into the same seam. The run uses `trusted` (worktree git ops + in-worktree writes); the broker still gates each effect.

## M7 — Provider router + plugins ✅
- Goal: multi-provider + extensibility.
- Build: `services/provider-router.ts` (registry, task-class routing, prompt cache, fallback, budget breaker), `services/plugin-host.ts` (load ABI v0, enforce declared capabilities via broker). Rust: `cosine_topk` for the embeddings retriever. Ship embeddings + LSP as plugins.
- Deps: M3. ADRs: 0007, 0009, 0011. Exit: a provider outage falls back without task failure; a sample tool plugin runs only with its declared capabilities.
- Note: providers are injected (`ProviderClient`), so routing/cache/fallback/budget-breaker are testable without network; concrete HTTP clients ship as `provider` plugins (deferred — the seam exists). `cosine_topk` implemented in the Rust core (`Float32Array` in → `Uint32Array` of row indices out). Bundled embeddings/LSP plugins are the remaining packaging step.

## Cross-cutting (every milestone)
- Tests live beside the milestone; `npm run typecheck` green before merge.
- Update the relevant ADR if a decision changes (status → superseded).
- The cognition loop emits durable journal entries (plan / step / verdict) via `TaskJournal` (node:sqlite); `archon status` reads them and `archon index` runs the incremental indexer. `loadConfig` merges `archon.config.json` over built-in defaults. (decision/diff/cost entries land once an LLM planner + provider costs are wired.)
