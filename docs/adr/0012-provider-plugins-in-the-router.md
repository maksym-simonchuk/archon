# 0012 — Provider plugins as a cap-gated router fallback

- Status: accepted
- Date: 2026-05-22
- Deciders: Archon core, Execution

## Context

ABI v0 (ADR-0009) defines a `provider`-kind plugin: `complete(req: RouteRequest)
=> Promise<Completion>`. The host loads these, but nothing routes to them. The
`ProviderRouter` (ADR-0007) routes by **task class → strength-ranked
`ModelSpec` → `ProviderClient`**, prices each call from the model's per-1k
rates, and guards a budget. A `ProviderPlugin` has **no model**: it is a
self-contained, self-pricing black box that takes a `RouteRequest` and returns a
fully-formed `Completion` (its own `modelId`, token counts, and `costUsd`). The
two contracts do not line up, which is why integration was deferred.

Two further forces:

- A provider plugin makes a network call carrying the **prompt** (which can
  contain repo content) to an endpoint the plugin chooses. The built-in
  SDK-backed clients only reach known providers; third-party plugin code could
  reach anywhere. Enablement is therefore a **trust decision**.
- The router is built eagerly at startup; plugins load lazily (`pluginHost()` is
  memoized and async). The router cannot hold a concrete plugin list at
  construction without forcing every command to import `.archon/plugins/`.

## Decision

Provider plugins join the router as a **terminal fallback lane**, not as
synthetic models:

1. **Fallback only.** Configured models are tried first via the existing route
   chain. Only when that chain is empty or every model fails does the router try
   provider plugins, in registration order. Configured providers always win.
2. **Self-priced, still budget-guarded.** The breaker is checked up front (a
   blown budget blocks models *and* plugins). On success the plugin's own
   `completion.costUsd` is added to the running spend — the plugin prices
   itself; the router does not re-price it from rates it doesn't have.
3. **`complete` only.** Plugins do not back `completeObject` (structured
   planning) or `streamComplete` (`/ask` streaming) — ABI v0 has no object/stream
   hook. Those paths remain model-only.
4. **Cap-gated enablement; substrate network.** A plugin enters the lane only if
   the policy grants every capability its manifest declares (via the host's
   shared `firstRefusal` gate — the same one `invokeTool`/`runVerifiers` use).
   Under `safe` (where `net` is *ask*) a network provider plugin is refused and
   never used; the operator opts in via a `trusted` profile or an explicit
   grant. The plugin's network call itself is **inference substrate** (like the
   built-in clients and the WASM core) — it is not re-gated per call; the broker
   still gates the fs/exec effects the resulting plan proposes.
5. **Lazy supply.** The router takes a memoized `providerPlugins?: () =>
   Promise<ProviderPlugin[]>` thunk, wired by the runtime to the (lazy) plugin
   host, so plugins load only when a fallback is actually needed. The router
   imports only the ABI *type*, not the host.

The router exposes the granted fallback providers via `fallbackProviders()`
(async — it consults the lazy supplier) so `archon model` lists them alongside
the model routing, while `routingTable()` stays pure/synchronous.

## Consequences

- Positive: provider plugins extend reach without distorting the model registry
  or pricing; the budget breaker stays honest; enabling one is an explicit,
  policy-visible trust step; laziness is preserved.
- Negative / cost: a small dedicated code path beside `route<R>`; plugins are
  second-class (no structured/streaming, fallback-only) until a richer ABI hook
  exists.
- Risk removed: silent prompt-exfiltration by untrusted completer code (R-trust)
  — a provider plugin runs only under a profile that grants its declared
  capabilities; runaway spend stays bounded by the same breaker.

## Alternatives considered

- **Synthetic `ModelSpec` + adapter `ProviderClient`** — rejected: forces the
  black box into rate-based pricing it didn't choose (losing its self-reported
  `costUsd`/`modelId`) and fabricates strengths/cost it doesn't have.
- **Ungated substrate (no capability check)** — rejected: a third-party
  completer receives the prompt and picks its own endpoint; enabling it must be
  a deliberate policy decision, not automatic on load.
- **Config-driven per-task plugin routing** — rejected as premature; a
  fallback lane covers the need now (mirrors ADR-0007's "static table suffices").
