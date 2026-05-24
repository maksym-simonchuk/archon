# 0014 — Mastra: workflow engine only; do not surrender provider routing or memory

- Status: accepted
- Date: 2026-05-24
- Deciders: Archon core

## Context

[mastra.ai](https://mastra.ai/) is a production-grade TypeScript agent framework
that overlaps Archon at three layers: **provider integration** (it wraps
`@ai-sdk/*`), **memory** (its own store), and **workflows** (`createStep`,
branching, parallel, `dowhile`, suspend/resume). It also ships an MCP client.

The user request "put Mastra in core and remove ai-sdk" is appealing — fewer
moving parts — but treats Mastra as a drop-in replacement for `ai`. It is not:

- Mastra uses `@ai-sdk/*` itself; "removing ai-sdk" would mean replacing our
  router with Mastra's `Agent`, which hides per-call streaming control we need
  for the v2 token-delta bus (M26).
- Mastra's memory store is ungated; our 3-tier memory (M5) enforces
  human-confirmed promotion (ADR-0008). Adopting Mastra memory would silently
  widen the trust boundary.
- Mastra workflows are *exactly* the DAG primitive M19 (`safe-refactor`) and
  M33 want and we don't have. Re-implementing them well is ~400 LoC of code
  we'd rather not own.

## Decision

Embed a thin slice of Mastra **as the workflow engine only**, behind
`src/cognition/workflow.ts`, in milestone M33. Adoption scope:

| Mastra primitive | Adopt | Notes |
| --- | --- | --- |
| `Workflow` / `createStep` / branching / parallel / suspend-resume | ✅ | The whole reason we're integrating. |
| `@mastra/mcp` | ✅ | For M30/M31 MCP client + server. |
| `Agent` | ✖ | Our M14 Agent Factory + AgentBroker own agent identity. |
| Provider integration | ✖ | Our M7 ProviderRouter owns routing, cache, fallback, budget. |
| `Memory` | ✖ | Our M5 store + promotion gate stay authoritative. |
| Evals | ⏳ | Ship later as the `archon-evals` plugin if useful (M36). |
| Logging / telemetry | ✖ | One bus; Mastra logs are bridged into our `EventBus`. |

**Boundary discipline**: every workflow step that needs a side effect calls a
broker shim (a Mastra-shaped tool whose body is a broker invocation). The
workflow engine itself imports zero from `fs` / `child_process` / `net`. The
shim throws on `deny` and uses Mastra `suspend` / `resume` to model the broker
`ask` state — approval cards on the bus drive the resume.

**Why we do not remove `ai-sdk` today:**
1. Our ProviderRouter is stable, fully tested, and instrumented for the v2 bus.
   Replacing it would churn ~460 tests for zero behavioural gain.
2. Mastra depends on `ai-sdk` transitively. Removing the direct dep saves
   nothing in lock files and loses our direct streaming control.
3. The integration cost is asymmetric: we can adopt Mastra workflows without
   touching the router; we cannot adopt the router without forking Mastra.

**Version policy**: pin `@mastra/core` minor; allow patch. Re-evaluate quarterly
or on a breaking change. If Mastra becomes unmaintained, replacing the
~400-line adapter is the only blast radius.

## Consequences

- **Positive:** ~400 LoC of DAG runtime saved; suspend/resume models the broker
  `ask` state elegantly; MCP client/server come for free via `@mastra/mcp`.
- **Negative / cost:** new external dep on a fast-moving framework; mitigated
  by the thin adapter and the version pin policy.
- **Risk removed:** owning a bespoke workflow runtime forever; ad-hoc skill
  composition; MCP from scratch.

## Alternatives considered

- **Adopt Mastra wholesale (replace router + memory)** — rejected for the
  reasons above; widens the trust boundary and churns stable code.
- **Hand-roll a DAG engine** — rejected: ~400 LoC of foreseeable
  reinvention with no differentiator.
- **Use LangChain's LCEL or LangGraph** — rejected: Python-first ecosystem,
  weaker TS story, opinionated about memory and state.
- **Defer workflow indefinitely** — rejected: M19 skills already want this
  shape; M33 unblocks council and multi-step orchestration.
