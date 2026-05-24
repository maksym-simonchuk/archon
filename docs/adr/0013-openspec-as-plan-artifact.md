# 0013 — OpenSpec as the load-bearing plan artifact

- Status: accepted
- Date: 2026-05-24
- Deciders: Archon core

## Context

M0–M24 ship Cognition with an internal `Plan` tree as the planner output and the
executor input. The tree is fit for purpose inside the process but is *opaque*
to humans, to reviewers, to other agents, and to teams who want plan diffs to be
reviewable like code diffs.

[Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) defines a small,
markdown-native change-proposal protocol that already encodes the
design-before-act invariant AGENTS.md mandates:

- `proposal.md` — *Why / What / Why-Now*
- `tasks.md` — checkbox tasks (a perfect Verifier success matrix)
- `design.md` — gated on Risk ≥ medium
- `specs/<context>/spec.md` — `ADDED|MODIFIED|REMOVED` delta operations

The format is human-readable, diff-able, and tool-agnostic — a Cursor or Claude
Code session can read and review what Archon emits.

## Decision

Adopt OpenSpec as the **public plan artifact** for Archon Runtime v2 (Milestone
M29). The internal `Plan` tree remains the execution-time representation; the
Planner emits both. Concretely:

1. `archon plan` and `archon run` emit a folder under
   `openspec/changes/<change-id>/` via the Capability Broker.
2. The Verifier treats `tasks.md` as the success matrix: every unchecked task is
   a failed gate.
3. The worktree transaction archives the change folder on commit
   (`openspec/archive/<change-id>/`) and discards it on rollback.
4. `archon spec status | diff | validate | archive` are the user commands.

We **re-implement** the OpenSpec validator in TypeScript (~200 lines, pure, no
I/O — see `src/cognition/openspec/validate.ts`) rather than vendoring the
upstream Node CLI. Reasons: zero new runtime dependency; the validator must run
inside the broker boundary (the upstream CLI is `fs`-touching); the structural
checks we need are small.

## Consequences

- **Positive:** plans become reviewable as code; teams can hand a `changes/`
  folder to another AI assistant; the archive becomes a free, architecturally
  aware changelog; `tasks.md` ↔ Verifier gate mapping is trivial.
- **Negative / cost:** two representations of the same plan (internal tree +
  spec folder) — must be kept coherent; mitigated by the Planner owning both.
  Approximately 400 lines of new code (types + validator + emitter).
- **Risk removed:** plan opacity → multi-agent reviewability; lock-in to a
  bespoke plan format we'd own forever.

## Alternatives considered

- **Vendor the upstream OpenSpec CLI** — rejected: adds an `fs`-touching
  dependency that violates the broker invariant (ADR-0003); we'd still need a
  TS facade.
- **Custom JSON plan format** — rejected: not portable to other tools, not
  human-reviewable as a diff, no narrative section for the rationale.
- **Markdown-only plans without delta sections** — rejected: loses the
  per-bounded-context delta resolution the spec store needs (M-late).
- **Defer until M-late** — rejected: spec format is the contract the rest of
  Phase E (token streaming, diffs, approvals) presents *against*. Lock it now.
