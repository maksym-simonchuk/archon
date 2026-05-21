# 0004 — Git-worktree transactions

- Status: accepted
- Date: 2026-05-21
- Deciders: Archon core

## Context

Multi-step edits must be reversible. We need a transaction with rollback and a
contained blast radius, without building a bespoke change-tracking engine.

## Decision

Risky / multi-file tasks run in a dedicated **git worktree**. Each plan step is a
**commit**; the Verifier runs; on green the worktree merges, on failure it is
discarded. **Git is the undo log** — no custom transaction engine. Read-only or
trivial tasks may run in place.

## Consequences

- Positive: reversible by default; blast radius contained to a worktree; history is reviewable as normal commits.
- Cost: disk + setup per risky task.
- Risk removed: data loss / destructive in-place writes; partial-apply corruption.

## Alternatives considered

- Bespoke transaction/rollback engine — rejected: reinvents git, more bugs.
- In-place edits with manual undo — rejected: unbounded blast radius.
