# 0001 — Record architecture decisions

- Status: accepted
- Date: 2026-05-21
- Deciders: Archon core

## Context

Archon makes several load-bearing architectural choices up front. Decisions made
in chat or commit messages get lost; future agents (and humans) then re-litigate
or silently violate them.

## Decision

Keep lightweight ADRs in `docs/adr/`, one file per significant decision, using
`template.md`. Changing a decision means adding a new ADR and marking the old one
`superseded` — never editing history. ADRs are referenced from code comments
(e.g. `// See ADR-0003`).

## Consequences

- Positive: durable rationale; agents can cite the constraint they must respect.
- Cost: a small writing step per decision.
- Risk removed: silent drift away from agreed architecture.

## Alternatives considered

- Wiki / chat history — rejected: not versioned with the code, not citable from source.
