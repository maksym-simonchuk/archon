# Archon — Architecture

Status: accepted (MVP scaffold). Atomic decisions live in [`adr/`](adr/).

## Mental model

A constrained AI staff engineer embedded in a repo. It runs one primitive —
**plan → act → verify → reflect** — one *smallest reversible increment* at a time,
**safe by default**. The system is **4 runtime planes** + a cross-cutting **Safety**
gate + shared **Services**. CPU-hot kernels run in a **Rust → WASM** core.

## Planes

| Plane | Responsibility | Key modules | Language |
| --- | --- | --- | --- |
| **Sensing** | Incremental index, symbol graph, budgeted context | `sensing/{indexer,symbol-graph,context-service}` | TS host + **Rust/WASM** kernels |
| **Memory** | episodic → semantic → procedural; human-gated promotion | `memory/{store,promotion}` | TS (+ Rust vector top-k) |
| **Cognition** | the plan→act→verify→reflect loop | `cognition/{planner,executor,verifier,reflector,loop}` | TS |
| **Effecting** | the single side-effect path: broker, policy, txn, audit | `effecting/{capability-broker,policy-engine,transaction,audit-log}` | TS |

## Topology

```
                ┌───────────────────────────────────────────────┐
   request ───► │  COGNITION   Planner→Executor→Verifier→Reflector│
                └───────┬───────────────▲───────────────┬────────┘
        working set     │               │ verdict       │ steps (tool calls)
                ┌───────▼───────┐  ┌─────┴──────┐  ┌─────▼──────────────────┐
                │   SENSING     │  │   MEMORY   │  │      EFFECTING         │
                │ Indexer       │  │ episodic   │  │ ┌────────────────────┐ │
                │ SymbolGraph   │  │ semantic   │  │ │ CAPABILITY BROKER  │ │ ◄─ SAFETY / POLICY
                │ ContextSvc    │  │ procedural │  │ │  fs · exec · net   │ │   (single gate)
                └──────┬────────┘  │ + promote  │  │ │  · secret vault    │ │   allow|ask|deny
                       │           └────────────┘  │ └─────────┬──────────┘ │   blast-radius cap
            bytes in / │ data out                  │  git-worktree txn      │   audit log
            ┌──────────▼──────────┐                │  verify→commit|rollback│
            │  RUST → WASM CORE    │  (pure, no I/O)└────────────────────────┘
            │  hash · parse · rank │
            │  · cosine-topk       │
            └─────────────────────-┘
   ┌───────────────────────────────────────────────────────────────────────────┐
   │ SERVICES:  Provider Router · Plugin Host (ABI v0) · Task Journal · Config    │
   └───────────────────────────────────────────────────────────────────────────┘
```

## Components

| Component | Spec | ADR |
| --- | --- | --- |
| Indexer | Merkle DAG of content hashes; reindex only `git diff` dirty paths. Never full-rescans. | 0005 |
| SymbolGraph | tree-sitter graph (defines/imports/calls/tests) in SQLite; `blastRadius()` = reachability. | 0005 |
| ContextService | repo-map (PageRank skeleton) + hash-keyed summaries + budgeted assembly; graph/lexical retrieval (embeddings = plugin). | 0006 |
| Compute core | Rust→WASM kernels: `hash_files`, `parse_symbols`, `rank_repo_map`, `cosine_topk`. Pure; no I/O. | 0011 |
| Memory | 3 tiers; promotion needs frequency+success+**human confirm**; decay/eviction; pinned ADRs. | 0008 |
| Cognition loop | smallest reversible step; resumable via journal; roles = prompt personas on one model by default. | 0002 |
| Capability Broker | the ONLY side-effect path; zero ambient authority; untrusted content = data, never instructions. | 0003 |
| Policy Engine | `(action,target,blastRadius)` → allow|ask|deny; profiles `safe`/`trusted`; default-deny. | 0003,0010 |
| Transaction | git worktree; commit micro-steps; verify; merge on green / discard on fail. | 0004 |
| Provider Router | model registry; task-class routing; prompt cache; static fallback; budget breaker; 2 providers. | 0007 |
| Plugin Host | 5-hook ABI v0; declared capabilities enforced by broker; sandboxed. | 0009 |
| Task Journal | append-only durable log; crash-resume + audit; plain state fold. | — |

## Data flows

- **F1 Ingest** — repo → watcher / `git diff` → dirty subtree → Rust core hashes + parses → graph + summaries → memory.
- **F2 Context** — task → retrieve (graph + lexical + memory) → Rust core ranks → compress → budget-fit → prompt.
- **F3 Execute** — request → plan tree → step → tool → **broker → policy** → worktree txn → verify → reflect → memory.
- **F4 Provider** — cognition call → router pick → cache check → invoke → account → fallback on failure.

## Two-language split (ADR-0011)

- **TypeScript host** owns orchestration, LLM calls, git/fs, and all side effects (broker). I/O-bound — Rust adds nothing here and loses the JS LLM/git ecosystem.
- **Rust → WASM core** owns CPU-bound kernels (hash, parse, rank, vector). Compiled with `wasm-bindgen` (`--target nodejs`), loaded once via `src/core/compute.ts`.
- The WASM sandbox **cannot** perform I/O → it has no ambient authority → it *reinforces* the broker safety model. The host passes bytes; the core returns data.
- Boundary discipline: coarse, batched calls with large buffers — the JS↔WASM copy cost dominates if chatty.

## What we deliberately did NOT build (anti-overengineering)

distributed actor framework · vector DB as a core dependency · bespoke transaction
engine (git does it) · auto-evolving skills · policy DSL · CQRS · full LSP in core ·
multi-process orchestration. Each is deferrable; several ship later as plugins.

## Build order

See [`ROADMAP.md`](ROADMAP.md). Single-process now; a multi-process deployment reads
the *same* Task Journal with no redesign.
