# 0015 — Runtime v2 safety invariants

- Status: accepted
- Date: 2026-05-24
- Deciders: Archon core

## Context

Runtime v2 (see `docs/RUNTIME-V2.md`) adds new surfaces — event bus, MCP
client/server, workflow engine, LSP bridge, replay — each of which could
become a side-channel that escapes the Capability Broker if we're not
deliberate. We need a single checklist that every new v2 module's PR is held
against.

## Decision

The following invariants are **non-negotiable** for every v2 module. PR review
applies them mechanically; CI enforces what it can.

1. **Single gate.** No module imports `fs` / `child_process` / `net` / `dns` /
   `http(s)` directly. Side effects go through the Capability Broker
   (ADR-0003). The `effecting/` plane is the only place that imports those
   modules; everything else uses the broker handle.
2. **Bus carries no authority.** The event bus is observational. Publishing an
   event is not an action. Subscribers cannot mutate engine state via the bus;
   if a subscriber needs to *act* (e.g. approve), it calls the broker
   explicitly through a separate handle.
3. **Producer never blocks on consumer.** A slow or absent subscriber must not
   pause the cognition loop or a provider stream. The bus uses a bounded
   per-subscriber ring with drop-oldest; loss is surfaced as a `bus.lost`
   event, not as back-pressure.
4. **Default deny on new capability namespaces.** Every new surface introduces
   a namespace in `.archon/policy.yaml` (`mcp:*`, `lsp:*`, `workflow:*`,
   `replay:*`). Defaults to `deny`. Profiles (`safe`, `trusted`) opt in
   explicitly.
5. **Untrusted content stays data.** MCP responses, OpenSpec content authored
   outside this repo, LSP `executeCommand` payloads, replay-fed bus events —
   all treated as data, never as instructions. Per AGENTS.md.
6. **Reversible by default.** All v2 file writes (spec folders, MCP-driven
   edits, workflow side effects) flow through the worktree transaction
   (ADR-0004). The TUI's diff/approval cards are the visible undo.
7. **No ambient authority for workflows / agents / plugins.** Mastra workflow
   steps, M14 agents, M19 skills, and v0/v1 plugins receive only a
   capability-scoped broker handle (M14 AgentBroker), never raw `fs` / `exec`.
8. **Provider streams emit telemetry, not control.** `token.delta`,
   `tokens.usage`, `verdict` events are observational. The router still owns
   routing, cache, fallback, and the budget breaker; the bus cannot redirect
   a stream.
9. **MCP server exposes a strict read-only subset by default.** Mutating MCP
   tools require an explicit opt-in under a non-`safe` profile (M31).
10. **Replay is read-only.** `archon replay <runId>` reconstructs UI events
    from the journal; it never re-issues broker calls. A "what if I re-ran
    this" rerun is a *new* run with its own broker mediation.

## Consequences

- **Positive:** v2 surfaces compose without widening the trust boundary; one
  page captures the rules; PR reviewers (human or AI) have a mechanical
  checklist; new contributors learn the invariant once.
- **Negative / cost:** more boilerplate around each new surface (an explicit
  broker handle, a policy entry, a profile gate). Mitigated by sane defaults
  in the v0/v1 plugin host and the AgentBroker.
- **Risk removed:** the v2 dashboard / orchestration features becoming side
  channels that bypass the M0–M24 safety chassis.

## Alternatives considered

- **Trust subscribers on the bus** — rejected; that's how live-runtime
  agent frameworks accumulate uncontrolled authority.
- **Allow workflow steps direct `fs` for "internal" operations** — rejected;
  the distinction between internal and external collapses the first time a
  plugin contributes a step.
- **Soft enforce via guideline only, no policy entries** — rejected; the
  M0–M24 substrate proves machine-enforced defaults catch the cases humans
  miss.
- **Defer the checklist until v2 ships** — rejected; the cost of writing v2
  modules against an explicit checklist is a tenth of refactoring them later.
