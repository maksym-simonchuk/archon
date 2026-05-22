# CLAUDE.md — Archon repo

**Read [`AGENTS.md`](AGENTS.md) first — it is the binding operating contract**
(design-before-act, minimal-diff, stay-in-scope, ask-gates, hard-denies). It overrides
default behavior in this repo.

## Project

Archon = a constrained AI staff-engineer runtime embedded in a repository.
Stack: **TypeScript / Node ≥ 20, ESM**. Status: **MVP scaffold** (typed stubs; logic
is tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md)).

## Layout

- `src/sensing` · `src/memory` · `src/cognition` · `src/effecting` — the four runtime planes
- `src/services` — provider router, plugin host, task journal, config loader
- `src/plugins/abi.ts` — Plugin ABI v0 (the only stable third-party contract)
- `docs/adr/` — architecture decisions · `docs/ARCHITECTURE.md` — overview · `docs/ROADMAP.md` — build plan
- `.archon/policy.yaml` — machine-enforced safety policy

## Commands

- `npm run typecheck` — must pass before "done"
- `npm run dev` — launch the interactive TUI (the sole surface; `/help` lists commands)
- `npm run build` — emit `dist/`

## Working here

- Pick the smallest open milestone in `docs/ROADMAP.md`; implement only that.
- Every side effect must go through the Capability Broker — never call `fs` / `child_process` / network directly in agent paths.
- Follow the `AGENTS.md` workflow gate. When in doubt, ask.
