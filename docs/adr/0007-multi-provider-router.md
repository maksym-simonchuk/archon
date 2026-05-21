# 0007 — Multi-provider router with fallback

- Status: accepted
- Date: 2026-05-21
- Deciders: Archon core, Execution

## Context

Relying on one LLM provider risks lock-in, outages, and rate limits. Different
task classes have different cost/quality needs (a summary ≠ a tricky diff).

## Decision

A **Provider Router** keeps a **model registry** (context window, cost, latency,
strengths) and routes by **task class** — cheap models for plan/summarize, strong
models for reason/diff. It adds an exact/prefix **prompt cache** (keyed on content
hash), a **static fallback chain** on error/rate-limit, and a **budget
circuit-breaker** (per-task + global). Start with two providers.

## Consequences

- Positive: no single-provider lock-in; cost control; resilience to outages.
- Cost: a registry + routing table to maintain.
- Risk removed: provider outage/lock-in (R7); runaway spend (R2).

## Alternatives considered

- Single provider — rejected: lock-in, no failover.
- A routing policy DSL — rejected: premature; a static table suffices now.
