# 0017 — Bus journal + replay

- Status: accepted
- Date: 2026-05-24
- Deciders: Archon core

## Context

Runtime v2 emits a continuous stream of `ArchonEvent`s on the in-process
event bus — `turn.start`, `token.delta`, `patch.staged`, `approval.request`,
`verdict`, etc. To debug, audit, and demo finished runs offline, we need to
*reconstruct* that stream without re-running the cognition loop (which would
re-issue broker calls and is non-deterministic).

Two requirements:

1. The journal must capture **every** event the bus carried for a run, in
   the exact order. Lossy capture defeats replay's purpose.
2. The replay command must be **read-only** (ADR-0015 invariant 10). It
   reconstructs UI events from the journal; it never reaches the broker.

A third pragmatic requirement: replay's `--live` mode publishes events back
through the same bus so TUI subscribers re-paint. This creates a loop —
the bus-journal recorder would re-record the replayed events forever.

## Decision

- **Subscriber-shaped recorder.** `buildRuntime` subscribes one async loop
  to the bus and calls `journal.appendBusEvent(e)` on every event. The
  recorder is lazy (the journal opens its sqlite db on first event) and
  failure-silent (a sqlite write error drops that row but never throws).
- **One row per event.** The `bus_journal` table stores `(seq, run_id, at,
  kind, event_json)`. `replayBus(runId)` returns rows in `seq` order. No
  compaction — Archon journals are local and small.
- **`replay()` is a pure stream re-emitter.** `src/ui/replay.ts` exposes
  `replay(source, runId, bus, opts)`: yields events from `source`, paces
  them with `opts.speed`, publishes through the bus. No fs, no broker.
- **Loop prevention via runId prefix.** When `/replay --live` publishes
  events back to the bus, each event's `runId` is rewritten to
  `replay:<original>:<n>`. The bus-journal recorder skips any event whose
  runId starts with `replay:`. Real events never use the prefix (the
  prefix is synthesized only inside the replay adapter), so production
  events pass through unaffected.
- **Replay never calls the broker.** Card subscribers (TUI patch /
  approval) observe events and render. If a card's "apply" or "approve"
  button is clicked during replay, the user is interacting with a fresh
  run, not retroactively mutating history — the original session is
  immutable.

## Consequences

- **Positive:** Replay works against any past run with zero special-case
  setup. `--live` exercises every TUI subscriber the same way a live
  session does, so a card-rendering bug surfaces during replay too.
  Recorder cost is O(events written) — bounded by per-run activity.
- **Negative / cost:** sqlite write per event. Negligible at typical
  cognition cadence (10s–100s of events per run). For provider streams
  emitting per-token `token.delta`, the cost is small but visible — we
  accept it because token-level replay is the only way to recreate the
  user-perceived streaming experience.
- **Risk removed:** Replay drift (the live re-emit subtly diverging from
  the original) can't happen at the event level, because the bytes
  emitted are the bytes recorded.

## Alternatives considered

- **No journal, file-based debug logs only** — rejected; logs aren't
  structured enough to drive UI re-render and require ad-hoc parsing per
  consumer.
- **A `meta: { replayed: true }` field on every event** — rejected;
  invasive — every event variant in the discriminated union needs the
  field, every producer remembers not to set it, every recorder remembers
  to check it. The runId prefix is a single guard in a single recorder.
- **Pause the recorder during `--live` replay** — rejected; race-prone
  (events published mid-pause-toggle could still slip through the async
  iterator's pending queue). The runId prefix is race-free.
- **Re-issue broker calls during replay** — rejected; that's `run
  --resume`, a separate path. Replay's value is precisely that it's
  side-effect-free.
