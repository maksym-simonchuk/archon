# 0006 — Context compression, not ingestion

- Status: accepted
- Date: 2026-05-21
- Deciders: Archon core, Context/Memory

## Context

Feeding whole files (or whole repos) into the model is the dominant cost driver
and blows the context window. Constraint: **compress context, do not ingest.**

## Decision

The Context Service assembles a **token-budgeted working set**: a **repo-map**
(PageRank-ranked symbol skeleton) plus on-demand expansion, with **hash-keyed
tiered summaries** (cache invalidates exactly on content-hash change). Default
retrieval is **graph + lexical** (ripgrep); a hard token budget degrades by
dropping lowest-rank context first, with per-chunk provenance. Embeddings are an
**optional Retriever plugin**, not a core dependency.

## Consequences

- Positive: bounded tokens/cost; exact cache invalidation; no embedding infra at core.
- Cost: ranking + summary maintenance (ranking runs in the Rust core, ADR-0011).
- Risk removed: context blowup (R2), stale context after edits (R3).

## Alternatives considered

- Full ingestion — rejected: cost, window overflow.
- Vector DB as a core dependency — rejected: infra + marginal recall for *code* (structure beats vectors); kept as an opt-in plugin.
