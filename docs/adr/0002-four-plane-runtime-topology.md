# 0002 — Four-plane runtime topology

- Status: accepted
- Date: 2026-05-21
- Deciders: Archon core

## Context

The design explored a 9-layer runtime. More runtime boundaries = more trust
seams to verify and more process/IPC overhead, with little benefit at MVP scale.

## Decision

Collapse the runtime into **four planes** — Sensing, Memory, Cognition, Effecting
— with a cross-cutting Safety gate and shared Services (provider router, plugin
host, task journal, config). The load-bearing primitive is the Cognition loop:
**plan → act → verify → reflect**, one smallest reversible increment at a time.

## Consequences

- Positive: fewer trust boundaries; clearer mental model; single-process simplicity.
- Cost: planes are conceptual, not hard process isolation (acceptable now).
- Risk removed: boundary sprawl and premature distributed-systems complexity.

## Alternatives considered

- 9 runtime layers — rejected: too many seams to verify.
- Microservices / actor framework — rejected: ops cost, race surface, no MVP need.
