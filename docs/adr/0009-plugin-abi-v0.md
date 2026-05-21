# 0009 — Plugin ABI v0 (five hooks)

- Status: accepted
- Date: 2026-05-21
- Deciders: Archon core

## Context

The core must stay small while still allowing extension (extra providers,
verifiers, retrievers, tools, skills) without forking or constant API churn.

## Decision

A frozen **Plugin ABI v0** with exactly five hook kinds: **Tool, Verifier,
Provider, Skill, Retriever** (`src/plugins/abi.ts`). Each plugin ships a
**manifest** declaring the capabilities it needs; those are **enforced by the
Capability Broker** (ADR-0003) — no plugin gets ambient authority. Optional
heavy features (embeddings, LSP) ship as plugins, keeping the core minimal.

## Consequences

- Positive: stable extension contract; small core; ecosystem without core churn.
- Cost: ABI changes are breaking and need versioning.
- Risk removed: plugin API churn; bloated core; plugin privilege escape.

## Alternatives considered

- A broad, evolving SDK — rejected: constant breakage.
- No plugin system — rejected: every feature bloats the core.
