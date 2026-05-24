# 0019 — `broker.fsDelete` capability

- Status: accepted
- Date: 2026-05-24
- Deciders: Archon core

## Context

The Capability Broker (ADR-0003) gates `fs.read`, `fs.write`, and the
small set of `exec.*` capabilities every cognition pathway needs. Until
M40, deletion was conspicuously absent: the M14 worktree transaction
discards uncommitted changes by deleting the worktree, but that path is
internal to `effecting/git.ts` and never exposed to cognition.

OpenSpec archive (ADR-0018) introduced the first cognition-driven need
for deletion: archiving a change copies its files to
`openspec/archive/<id>/` and must remove the source folder
`openspec/changes/<id>/` for the active list to stay accurate.

The naive options — `await rm()` directly, or "we'll just leave the
active folder around" — both fail:

- Direct `rm()` re-introduces ambient `fs` authority into cognition.
- Leaving stale active folders makes `/spec status` show ghosts.

## Decision

Add `fsDelete(target, opts)` to `CapabilityBroker`:

```ts
broker.fsDelete(target: string, opts: {
  reason: string;
  recursive?: boolean;
  blastRadius?: BlastRadius;
}): Promise<void>
```

- Gated by a new `fs.delete` capability in the policy schema. **Default
  deny** for every profile; opt-in per profile under
  `profile.<name>.allow: [{ action: 'fs.delete', target: '...' }]`.
- Path-contained: the target is resolved against the broker's root and
  must not escape the worktree. Symlink resolution uses the same
  `realContainedPath` helper as `fsWrite`.
- `recursive: true` is required for non-empty directory deletes. The
  default (false) refuses recursive removes — a misconfigured deletion
  cannot accidentally clear a subtree.
- Audit-logged like every other broker call: `audit.log({ action:
  'fs.delete', target, reason, blastRadius })`.

The only caller in this cycle is `BrokerSpecStore.archiveChange` — best-
effort cleanup after a successful copy to archive. A policy deny leaves
the active folder in place; the archive write succeeded, so the
historical record is intact.

## Consequences

- **Positive:** Deletion joins the rest of `fs.*` under one gate.
  `effecting/`-internal paths still use raw `fs/promises`; cognition
  paths route through the broker like every other side effect.
- **Negative / cost:** Each profile that wants to archive specs must
  add an `fs.delete` grant. The default-`safe` profile does *not*
  grant delete (archiving requires an explicit profile switch). We
  judged that more aligned with "tighten-only" (ADR-0015) than a free
  delete capability.
- **Risk removed:** A bug in `archiveChange` or any future deletion
  caller can't reach outside `openspec/` because path containment is
  enforced before the `rm` call.

## Alternatives considered

- **Skip the active folder cleanup** — rejected; `/spec status` would
  list both archived and never-deleted active copies, confusing the
  user. The "active" / "archived" split must be authoritative.
- **A higher-level `broker.archiveTree(src, dst)` operation** —
  rejected; archive is a `cp + rm` pair, and pairing them inside the
  broker re-implements logic that belongs in the caller (the spec
  store). The broker stays a thin gate.
- **Allow `recursive` to default `true`** — rejected; a stray
  `fsDelete('.')` would clear the repo. Requiring explicit
  `recursive: true` makes the intent legible at the call site.
- **Add `fs.delete` to the `safe` profile by default** — rejected;
  the value of a default-`safe` profile is that destructive caps
  must be opted into per profile. Delete fits that pattern.
