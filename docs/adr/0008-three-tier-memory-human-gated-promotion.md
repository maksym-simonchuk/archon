# 0008 — Three-tier memory, human-gated promotion

- Status: accepted
- Date: 2026-05-21
- Deciders: Archon core, Context/Memory, Safety

## Context

Archon needs long-term memory that improves over time, but auto-learned
behaviour can silently regress: one bad "playbook" poisons every future run.

## Decision

Three tiers: **episodic** (task runs) → **semantic** (decisions/ADRs/facts,
content-hash keyed) → **procedural** (playbooks). Promotion to a higher tier
requires **frequency + success AND an explicit human/heuristic confirmation** —
never silent. Eviction by recency/frequency/relevance decay; ADRs are pinned.

## Consequences

- Positive: durable, queryable memory; controlled evolution.
- Cost: a confirmation step before procedural memory is trusted.
- Risk removed: memory drift / bad-skill propagation (R6).

## Alternatives considered

- Fully auto self-improving skills — rejected: unbounded risk, near-zero early ROI.
- No procedural memory — rejected: forfeits the main long-term-value path.
