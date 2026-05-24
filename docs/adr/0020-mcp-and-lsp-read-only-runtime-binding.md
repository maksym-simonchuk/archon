# 0020 — MCP read-only surface + LSP runtime binding

- Status: accepted
- Date: 2026-05-24
- Deciders: Archon core

## Context

M31 (MCP server) and M39 (LSP bridge) both expose Archon's intelligence to
external agents/editors. The substrate was shipped in earlier cycles
(`McpServer`, `ArchonLspServer`) but neither was wired to real runtime
queries — they accepted `tools: ServerTool[]` / `handlers:
ArchonLspHandlers` as injection points without supplying a concrete
implementation.

Three forces shape the binding decision:

1. **Two surfaces, one source of truth.** If MCP and LSP each compute blast
   radius independently, they drift. A client noticing the divergence
   distrusts both.
2. **Default-deny is the v2 invariant.** ADR-0015 #9 says the MCP server
   exposes a strict read-only subset by default; mutating tools require
   explicit opt-in. The LSP bridge — newer, less battle-tested in this
   codebase — should inherit the same policy.
3. **Editors care about shape, not internals.** An LSP client wants a
   trimmed diagnostic envelope (`files` + `symbols` only); an MCP client
   wants the full report (`target`, `seeds`, `dependents`, `files`,
   `indexed`). The shapes diverge intentionally.

## Decision

- **Shared compute primitives.** `src/services/mcp/archon-tools.ts` exports
  `computeBlastRadius`, `computeExplain`, `computeViolations`,
  `computeMap` as pure functions over `Runtime`. They open the
  `IndexStore` existsSync-guarded, so a fresh repo with no index returns
  the shape's zero-value envelope rather than throwing. Both surfaces
  import these.
- **MCP read-only tools.** `archonReadOnlyTools(rt)` returns
  `ServerTool[]` with `mutating: false`. Server-side, `McpServer`'s
  `mutatingEnabled` gate is off by default. Inbound clients see only
  `archon.blastRadius`, `archon.explain`, `archon.violations`,
  `archon.map`.
- **LSP runtime handlers.** `archonLspHandlers(rt)` returns
  `ArchonLspHandlers` wired through the *same* compute primitives, with
  shape trimming + LSP severity mapping (`high→1 Error`, `medium→2
  Warning`, `low→3 Information`). `workspace/executeCommand` has its
  own allowlist that mirrors the read-only verbs — any other command
  throws "not bound".
- **Inspection without a real client.** `/mcp tools` lists the bound MCP
  surface; `/lsp [list|blast|explain|violations]` runs the LSP handlers
  inline. Useful for diff-debugging the indexer and verifying the bridge
  before an editor connects.

## Consequences

- **Positive:** MCP and LSP cannot drift — both surfaces are thin
  adapters over the same `compute*` functions. Adding a future read-only
  query (e.g. `archon.philosophy`) is one new compute + two trivial
  bindings. The default-deny posture carries from M31 to M39 with no
  per-surface re-litigation.
- **Negative / cost:** A single compute returning the full report means
  the LSP path discards fields it doesn't need (`indexed`, `seeds`).
  Negligible — the data is tiny and the path is read-only.
- **Risk removed:** "MCP says X, LSP says Y, who's right?" — the bug
  shape that erodes trust in cross-tool integrations.

## Alternatives considered

- **One shape across both surfaces** — rejected; LSP clients reasonably
  expect a trimmed envelope and the MCP shape carries debugging fields
  (`indexed`) that aren't useful as LSP diagnostics. The shape trim is
  cheap and worth the integration ergonomics.
- **Direct re-imports of `cmdImpact` / `cmdExplain`** — rejected; the
  `cmd*` functions print + dispatch JSON vs prose modes (they're a CLI
  layer). The compute primitives are the *core* of that work, lifted out
  so the MCP / LSP layers don't pay for printing.
- **Mutating tools on by default in `trusted`** — rejected; the v2
  invariant is per-tool opt-in regardless of profile. A `trusted`
  Archon may *load* mutating tools; exposing them outbound is its own
  decision.
- **Defer the LSP wiring to a VS Code extension PR** — rejected; the
  handlers are independent of any editor packaging. Building them now,
  with tests, keeps the substrate honest and packageable.
