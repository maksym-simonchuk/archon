# Archon

> A constrained AI staff-engineer runtime embedded in a repository.
> Safe-by-default · incremental · memory-driven · context-efficient · multi-agent coordinated.

**Status:** MVP scaffold — typed stubs across the full architecture. Logic is tracked
milestone-by-milestone in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## What it is

Archon behaves like a careful staff engineer working inside your repo: it **designs
before it acts**, makes the **smallest reversible change**, **verifies** before claiming
done, and **never** performs destructive or out-of-scope actions without approval.

- Operating rules → [`AGENTS.md`](AGENTS.md)
- Architecture → [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Decisions → [`docs/adr/`](docs/adr/)

## Two-language design

| Layer | Language | Why |
| --- | --- | --- |
| Orchestration, LLM, git/fs I/O, safety | **TypeScript / Node** | I/O-bound; rich LLM SDK + git ecosystem |
| Hot CPU kernels: hashing, parsing, ranking, vector | **Rust → WASM** | native-class speed; sandboxed = no ambient authority (ADR-0011) |

## Layout

```
archon/
├── AGENTS.md                 # binding agent operating contract
├── CLAUDE.md                 # Claude Code pointer + repo quick rules
├── archon.config.json        # runtime config: providers, routing, budgets
├── .archon/policy.yaml       # machine-enforced safety policy (allow|ask|deny)
├── crates/archon-core/       # Rust→WASM compute core (hot paths)
├── docs/
│   ├── ARCHITECTURE.md       # the consensus design (4 planes + services)
│   ├── ROADMAP.md            # build plan M0..M7
│   └── adr/                  # architecture decision records
└── src/
    ├── core/                 # shared types, Result, ComputeCore facade
    ├── sensing/              # indexer, symbol graph, context service
    ├── memory/               # 3-tier store + human-gated promotion
    ├── cognition/            # plan -> act -> verify -> reflect loop
    ├── effecting/            # capability broker, policy engine, txn, audit
    ├── services/             # provider router, plugin host, journal, config
    └── plugins/abi.ts        # Plugin ABI v0
```

## Quickstart

```bash
npm install
npm run typecheck          # must pass
npm run dev                # launch the interactive TUI (/help lists commands)

# Compute core (optional until M1; needs Rust + wasm-pack):
npm run build:wasm
```

## Core invariants

- Every side effect goes through the **Capability Broker** — zero ambient authority (ADR-0003).
- Default profile is **safe** (`.archon/policy.yaml`): read freely, write narrowly, ask on risk, deny destructive (ADR-0010).
- **No full-repo rescans**; context is **compressed, not ingested** (ADR-0005, ADR-0006).
- Risky work runs in an isolated **git worktree**; git is the undo log (ADR-0004).
- Hot CPU paths live in the **Rust/WASM core**, which has no I/O access (ADR-0011).

## Editor / agent integration (M30/M31/M39)

Archon exposes the same read-only intelligence surface over **two open
standards** — MCP for agents, LSP for editors. Both are *read-only by default*
(ADR-0015 #9 + ADR-0020); mutating tools require an explicit `--mutating`
opt-in that the entry points below do not take. *Configured ≠ authorized*:
adding a server to `mcp.yaml` is not enough on its own — outbound MCP calls
also need a matching `mcp:*` grant in `.archon/policy.yaml`.

| Surface | Command | Wire | Methods |
| --- | --- | --- | --- |
| **MCP server** (inbound — Claude Code, Cursor, Codex talk to Archon) | `archon mcp` | line-delimited JSON-RPC over stdio | `archon.blastRadius` · `archon.explain` · `archon.violations` · `archon.map` |
| **MCP client** (outbound — Archon calls other MCP servers) | configure in `.archon/mcp.yaml` + grant `mcp:<server>:<tool>` in policy | line-delimited JSON-RPC over stdio | depends on the server |
| **LSP server** (inbound — VS Code, Neovim, JetBrains talk to Archon) | `archon lsp` | Content-Length-framed JSON-RPC over stdio | `archon/blastRadius` · `archon/explain` · `archon/violations` + `workspace/executeCommand` |

Inspect the surfaces interactively from the TUI:

```text
/mcp list           # policy grants per namespace (default-deny)
/mcp tools          # the inbound read-only surface (4 tools)
/mcp servers        # outbound servers configured in .archon/mcp.yaml
/mcp check claude-code:tools/list   # dry-run authorize a capability
/lsp list           # the LSP method surface
/lsp blast src/x.ts # what would the editor see for this file
```

`archon doctor` summarises the same numbers in one line — both inbound counts
and how many policy grants exist for the outbound side — so you can confirm
the gap between *configured* and *authorized* at a glance.
```
