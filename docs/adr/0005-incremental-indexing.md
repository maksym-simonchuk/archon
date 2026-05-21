# 0005 — Incremental indexing (no full rescan)

- Status: accepted
- Date: 2026-05-21
- Deciders: Archon core, Data/Graph

## Context

Re-reading an entire repository on every task is slow and expensive and does not
scale to large/monorepos. A hard constraint: **no full-repo rescans.**

## Decision

Maintain a **Merkle DAG** of file content hashes and reindex **only** the paths
reported by `git diff` / the file watcher. Build a **tree-sitter symbol graph**
(defines / imports / calls / tests) in embedded SQLite. `blastRadius()` =
reachability over that graph, feeding both context selection and the policy
ask-threshold. On wake, reconcile against `git status`.

## Consequences

- Positive: O(changed) indexing; structural retrieval and blast radius for free.
- Cost: incremental graph updates must handle renames/moves carefully.
- Risk removed: cost/latency blowup; over-broad edits (blast radius is computed).

## Alternatives considered

- Full rescan each run — rejected: cost, latency.
- LSP as the core parser — rejected: heavy, per-language daemons; offered later as a plugin.
- Embeddings as primary code retrieval — see ADR-0006.
