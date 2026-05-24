# 0016 — PatchStore + staged-diff UX

- Status: accepted
- Date: 2026-05-24
- Deciders: Archon core

## Context

Cognition v1 wrote files through the Capability Broker directly: plan → act →
verify → reflect, with the broker call sandwiched inside `act`. That works
for autonomous loops but leaves no human gate between *intent to write* and
*write applied*. Runtime v2 (M27) adds an interactive surface — `/diff` —
that must:

- Show the user every file edit + hunk that cognition wants to apply.
- Let the user toggle individual hunks on/off without re-running cognition.
- Apply only the accepted hunks through the broker, preserving the M14
  preservation gate and the M19 structural hooks.
- Never let the renderer (TUI) reach `fs` directly. Renderers observe state;
  the broker performs effects (ADR-0003, ADR-0015).

The naive solution — a global mutable patch object on `Runtime` — couples
cognition timing to UI rendering and makes replay impossible (the patch
state isn't on the bus).

## Decision

Introduce `PatchStore` in `src/cognition/patch-store.ts`:

- **Pure state container.** Holds at most one staged `PatchSet` per runtime.
  No `fs`, no `child_process`. The broker is consulted only when `apply()`
  is called via `cmdDiff('apply')`.
- **Bus-fed.** Cognition stages a patch by calling `patches.stage(set)`,
  which publishes `patch.staged` on the bus. The TUI subscribes and renders
  a cyan card. Toggles publish `patch.toggled`; applies publish
  `patch.resolved`; discards publish `patch.discarded`. Replay re-renders
  the card by re-emitting these events (M38 / ADR-0017).
- **Hunk granularity.** A `PatchSet` is `{ edits: [{path, diff: {hunks}}],
  accepted: boolean[][] }`. `accepted[i][j]` mirrors the i-th edit's j-th
  hunk. The TUI's `/diff toggle e.h` flips that bit; `apply` materialises
  only the accepted hunks into a write through the broker.
- **The TUI never writes.** It only calls `patches.toggle()` / `apply()` /
  `discard()`. Those methods either update internal state or delegate to
  the broker. There is no path from the renderer to `fs`.

## Consequences

- **Positive:** Cognition's intent-to-write is observable on the bus and
  reviewable in the UI before any write happens. The store has no
  authority — failure surface stays in the broker. Replay can reconstruct
  the staged-diff card from the journal alone, no special-case logic.
- **Negative / cost:** One more service to wire into `buildRuntime`. The
  bus protocol grows four new event kinds.
- **Risk removed:** A TUI bug couldn't accidentally write the wrong file,
  because the renderer can't reach `fs` to begin with.

## Alternatives considered

- **Inline the patch state in the cognition loop** — rejected; the loop
  would have to know about UI lifetimes (toggle-then-apply across user
  thinking time), reintroducing the timing coupling we wanted to remove.
- **Apply hunks through the bus directly** — rejected; the bus carries no
  authority (ADR-0015 invariant 2). A subscriber that received a
  `patch.apply` request would either need its own broker handle (defeating
  the centralization) or skip the broker (defeating the safety guarantee).
- **Render whole-file diffs only, no hunk toggle** — rejected; the user
  feedback from M19/M20 was that "all-or-nothing diff" loses the user's
  ability to accept the right structural change while rejecting a stray
  cosmetic edit. Hunk granularity is the minimum useful gate.
