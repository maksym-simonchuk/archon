# 0018 — BrokerSpecStore + planner emit

- Status: accepted
- Date: 2026-05-24
- Deciders: Archon core

## Context

ADR-0013 chose OpenSpec change folders (`openspec/changes/<id>/`) as the
plan artifact format. The Planner produces a structured `CognitivePlan`
that drives the executor; the change folder is a *parallel* human-readable
artifact that captures the same plan as markdown.

Two problems if naively wired:

1. **Direct fs writes.** The planner is in `src/cognition/`. Writing
   change folders directly from there would import `fs` into a non-
   effecting plane, violating the four-plane topology (ADR-0002) and the
   single-gate invariant (ADR-0015 #1).
2. **Validator drift.** Hand-rolled markdown emit (`## Tasks`, `## What`)
   diverges from the validator's expectations. A planner-emit pipeline
   that writes invalid changes is worse than no pipeline at all.

## Decision

- **`BrokerSpecStore` is the only filesystem-backed `SpecStore`.** Every
  read, write, list, and archive operation routes through a
  `CapabilityBroker` rooted at the repo. The planner-emit pathway, the
  `/spec` slash command, and any future spec-consuming tool all share
  this single store, so policy gates apply uniformly.
- **The emitter is the canonical formatter.** `emitChange(change)` in
  `src/cognition/openspec/emit.ts` writes the exact markdown the
  validator accepts. `changeFromPlanSummary()` builds the
  `OpenSpecChange` object from a `CognitivePlan` and delegates to
  `emitChange()` — the round-trip emit→parse→validate is property-tested
  in `validate.test.ts`.
- **Plan emit is best-effort, never blocking.** `emitOpenSpecChange()` in
  `commands.ts` wraps the store write in try/catch. A broker deny (the
  active profile doesn't grant write to `openspec/`) or a disk error
  logs nothing and continues; the plan UX is not held hostage to the
  artifact pipeline.
- **Archive cleanup goes through the broker.** Archiving a change copies
  its files to `openspec/archive/<id>/` and then deletes
  `openspec/changes/<id>/` via `broker.fsDelete(path, { recursive:
  true })` (ADR-0019). Best-effort: a delete refusal leaves the active
  copy in place, but the archive write is complete.
- **No special profile for spec writes.** Spec folders live under the
  repo's `openspec/` tree; the same `fs.write` / `fs.delete` caps a
  profile already grants for source code apply here. We did *not*
  introduce a `spec.*` v2 capability — every additional namespace is a
  promise to maintain.

## Consequences

- **Positive:** A single emit pipeline, validator-locked. Plans and
  hand-authored changes share one format. Policy gating applies to
  artifacts as it does to source. The store can be swapped (an
  in-memory test double) without changing callers.
- **Negative / cost:** A planner that wants to emit a richer change
  (design narrative, delta specs) must extend `changeFromPlanSummary`
  rather than write markdown directly. We accept this because
  validator-locked emission is the entire point.
- **Risk removed:** Invalid plan artifacts shipping to other tools that
  consume OpenSpec.

## Alternatives considered

- **Write change folders directly from the cognition plane** — rejected;
  imports `fs` into a non-effecting plane, makes policy gating
  case-by-case, and re-implements the broker's path-containment logic.
- **Skip the artifact entirely; structured `CognitivePlan` is enough** —
  rejected; humans review plans, not JSON structs, and other tools in
  the OpenSpec ecosystem speak the markdown format.
- **Block the plan flow on artifact write success** — rejected; a
  policy deny on a low-stakes write would freeze planning. Best-effort
  with bus-level visibility (`plan.ready` publishes the spec path on
  success) is the right tradeoff.
