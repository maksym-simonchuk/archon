# 0010 — Safe-by-default profiles + design-before-act

- Status: accepted
- Date: 2026-05-21
- Deciders: Archon core, Safety

## Context

An autonomous engineer in a repo can do real damage. The default posture must be
conservative, and the agent must plan before it edits — not the reverse.

## Decision

Two profiles in `.archon/policy.yaml`. **`safe` is the default**: read freely,
write narrowly (ask above the blast-radius threshold), **deny** the destructive
class (force-push, history rewrite, `rm -rf`, secret read), network egress asks.
**`trusted`** raises autonomy **only inside an isolated worktree** and still
denies the destructive class. **No auto-escalation** between profiles. The
human-readable contract is `AGENTS.md` (design → minimal diff → verify gate);
`policy.yaml` is its machine-enforced mirror.

## Consequences

- Positive: damage is opt-in, never accidental; behaviour is auditable and predictable.
- Cost: more "ask" prompts in `safe` mode.
- Risk removed: destructive writes (R1); silent over-reach.

## Alternatives considered

- Trusted-by-default — rejected: unsafe.
- No profiles (one fixed policy) — rejected: too rigid for CI vs local use.
