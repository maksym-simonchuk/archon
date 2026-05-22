# ROADMAP — Repository Intelligence (Archon v1)

Status: planning. This is the **second half** of Archon — the layer that turns the
M0–M7 *safety + cognition skeleton* (see [`ROADMAP.md`](ROADMAP.md)) into the
**project-native engineering intelligence system** described in the spec: deep
structural understanding, architecture preservation, violation governance, and
constrained autonomous evolution.

Same rules as M0–M7: implement per [`AGENTS.md`](../AGENTS.md) (design → minimal diff
→ verify); one milestone ≈ one reviewable branch; fill stubs, don't rewrite working
planes. Legend: ✅ done · 🟡 partial · ⬜ todo.

---

## 1. Where we are vs. the spec

The spec asks for a *repository operating system*. What exists today is the
**execution substrate** for one — not yet the intelligence on top.

| Spec pillar | Today | Gap |
| --- | --- | --- |
| `ai init` deep structural analysis | 🟡 scaffolds policy/config only | No stack/monorepo/CI detection, no architectural fingerprint |
| Architectural intelligence (boundaries, ownership, criticality) | ⬜ | Symbol graph exists; no domain/boundary model |
| Project memory generation (CLAUDE.md, AGENTS.md, project-memory.md, conventions) | ⬜ | 3-tier memory store exists; nothing generates project intelligence |
| Context Compiler (intent-aware, bounded-context-scoped) | ✅ intent-scoped packets (bounded context + impact surface + ADR recall, with provenance) | Risk/test-coverage injection deferred (needs M13 wire / M19) |
| Agent Factory (project-native generated agents) | ✅ specs generated from stack + topology + philosophy, **+ runtime binding** (`selectAgent`/`agentBriefing` → prompt; `AgentBroker` → capability-scoped authority; `/agent --run`) | — |
| Autoskills (executable analyze→simulate→validate→execute→rollback workflows) | 🟡 skills = passive Markdown; pre/post hook engine now exists | Multi-phase executable skill runtime deferred (M19 note) |
| Hooks engine (pre/post: forbidden-import, boundary, lint/typecheck/test/regression) | ✅ static pre-write gate, **now wired into the loop** (blocks before any worktree) + post-write check specs | — |
| Preservation layer (intentional vs accidental complexity) | ✅ classifier + gate (preserve/caution/allow) | Advisory; not yet a hard write-block (M14 note) |
| Violation intelligence (leaks, cycles, dead code, god modules, drift…) | ⬜ | `doctor` is readiness only, not health |
| Architecture invariants + region classification (stable/evolving/experimental) | ⬜ | Policy denies destructive ops; no code-region governance |
| Risk engine (low/med/high/critical → autonomy scaling) | 🟡 blast-radius gate | No risk scoring, no test-regression probability |
| Execution simulation (pre-apply impact prediction) | 🟡 worktree verify (post-hoc) | No pre-apply simulation |
| Temporal evolution (drift/coupling/tech-debt trends, prediction) | ⬜ | Journal exists; no time-series analysis |
| Decision intelligence (auto ADR snapshots, why/tradeoffs/rejected) | ⬜ | ADRs are hand-written |
| Philosophy + economics + confidence layers | ⬜ | None |
| Autonomous improvement (`ai improve`/`refactor`/migration plans) | ✅ `improve` proposes ranked, ROI-gated, preservation-safe changes; `refactor` applies one through the simulation/preservation gate + a capability-scoped agent + worktree | engineering-economics ROI *ceiling* deferred |
| Daemon runtime (`ai watch`, FS/AST watchers) | ⬜ | Incremental indexer exists; no daemon/watcher |
| Provider orchestration (Claude/OpenAI/Gemini/local, task-routed) | 🟡 anthropic+openai | No Gemini, no local; routing exists |
| Rust core: tree-sitter, real vector store | 🟡 heuristic parser + `cosine_topk` | tree-sitter deferred; no persisted vector index |

**CLI coverage** (spec → status): `init` ✅(scan+memory) · `doctor` ✅(health score + evolution) ·
`memory` ✅(list/graph/recall) · `graph` ✅(map/explain/path) · `plan` ✅ ·
`violations` ✅ · `risk` ✅ · `evolution` ✅ · `decisions` ✅ · `improve` ✅ · `refactor` ✅(simulation-gated, agent-scoped) ·
`boundaries` ✅ · `watch` 🟡(incremental tick + background poller) · `agents` ✅ · `agent` ✅(bind+run, capability-scoped) · `philosophy` ✅ · `preserve` ✅ · `hooks` ✅ ·
`explain` 🟡(symbol≠architecture reasoning).

---

## 2. Milestone plan (M8 → M24)

Continues the M0–M7 numbering. Each milestone names its **deps** so the build
order is a DAG, not a straight line. Grouped into 4 phases.

### Phase A — Repository Intelligence (the missing foundation)

#### M8 — Structural Analyzer (`init` deep scan) ⬜
- Goal: `archon init` performs real repository intelligence extraction, not just policy scaffolding.
- Build: detect monorepo/polyrepo, package manager, build system, CI/CD, framework stack (frontend/backend/infra), test runner. Infer architectural style (layered / feature-sliced / modular-monolith / DDD), layering directions, entry points. Emit an **architectural fingerprint** persisted to the index DB.
- Deps: M1 (indexer), M2 (repo-map). Exit: `init` on a real repo prints stack + style + fingerprint; re-run is incremental (no full rescan).

#### M9 — Domain & Boundary Inference ✅
- Goal: a living model of bounded contexts and module topology.
- Build: cluster the symbol graph into modules; infer bounded contexts, module ownership, shared/core modules, coupling hotspots, unstable zones, circular-dependency seeds. New CLI `boundaries`.
- Deps: M8, symbol-graph. Exit: `boundaries` lists contexts + coupling hotspots; identifies the top god-module candidates.
- Done: M8.5 added cross-file `imports` edges (host-side resolver, `file_edges` table) as the substrate; `inferBoundaries` lifts them to a directory-module graph → fan-in/out, Martin instability, core/unstable roles, coupling hotspots, god-module candidates, SCC cycle seeds. `/boundaries` (`src/sensing/boundaries.ts`, `cmdBoundaries`).

#### M10 — Project Memory Generation ✅
- Goal: turn structural analysis into persistent, machine-readable project intelligence + the human-facing memory files.
- Build: generate/refresh `CLAUDE.md`, `AGENTS.md`, `project-memory.md`, conventions, constraints from M8/M9; store a machine-readable intelligence layer in SQLite (module intelligence, criticality, summaries). Extend `memory` with a graph/intelligence view.
- Deps: M8, M9, M5 (memory store). Exit: `init` produces project-native memory files; `memory --graph` renders the intelligence layer; regeneration is diff-aware (preserves human edits).
- Done ("new file only" scope — CLAUDE.md/AGENTS.md left untouched, they are the human contract): `init` generates `.archon/project-memory.md` (`renderProjectMemory`, archon-owned banner) from the fingerprint + boundary model, diff-aware via an embedded `archon:hash` keyed on `inputHash`+model; persists the boundary model to the `module_intelligence` SQLite table; `memory graph` (`cmdMemoryGraph`) renders that layer back. `src/memory/project-memory.ts`.

#### M11 — Convention & Philosophy Engine ✅
- Goal: infer the project's engineering culture so recommendations adapt to it.
- Build: detect naming/layering conventions, typing strictness, abstraction tolerance, startup-vs-enterprise and speed-vs-stability bias. Persist as a philosophy profile feeding later recommendation gates.
- Deps: M8. Exit: a philosophy profile is emitted and stored; conflicting recommendations are tagged against it.
- Shipped: pure `inferPhilosophy` (`src/sensing/philosophy.ts`) → typing strictness (tsconfig), abstraction tolerance (mean module fan-out + layering style), stability bias (test ratio + CI), scale (file count + monorepo), naming convention (file-stem sample), each with explainable rationale. `/philosophy` (`cmdPhilosophy`). It feeds M14 + M18 + M21 directly (passed in, not persisted — re-derived from the index on demand). No new deps.

### Phase B — Health & Governance

#### M12 — Violation Intelligence ✅
- Goal: continuous repository health with severity + impact, not just detection.
- Build: detect boundary leaks, dependency violations, circular deps, dead code, duplicated logic, god modules, invalid layering, over-coupling, missing tests, inconsistent patterns; score each by severity × business impact (uses M9 criticality). New CLI `violations`; upgrade `doctor` into an architecture-health report.
- Deps: M9. Exit: `violations` ranks findings by impact; `doctor` reports health score, not just readiness.
- Done: `detectViolations` (`src/sensing/violations.ts`) emits the high-confidence detectors the substrate supports — circular deps (high), god modules (med), stable-dependency-principle violations (med), missing tests (low) — each scored severity × (1 + module criticality/fanIn) and ranked. `healthScore` = 100 − weighted penalties. `/violations` (`cmdViolations`) lists them; `doctor` now carries a `health` block (score + severity counts). Deferred (need signals not yet indexed): dead code, duplication, layering, inconsistent patterns.

#### M13 — Risk + Confidence + Invariants Engine 🟡 (read-only slice)
- Goal: governance primitives that scale autonomy to safety.
- Build: classify code regions (stable / evolving / experimental / deprecated) and NEVER-MODIFY zones (auth, payments, public APIs, infra). Per-module **confidence score**. **Risk scoring** (low/med/high/critical) from blast radius + criticality + confidence + test-regression probability. Wire into the Policy Engine so autonomy/approval scale with risk.
- Deps: M9, M12. Exit: a write into a critical/low-confidence region escalates to `ask`; risk level is attached to every planned step.
- Done (advisory slice — Policy Engine deliberately UNTOUCHED, pending its own review): `scoreRisk` (`src/cognition/risk.ts`) → low/med/high/critical from blast radius + module criticality (fan-in) + confidence (test-coverage ratio, `moduleConfidence`) + never-modify zones; coarse region from module role. `/risk <file>` (`cmdRisk`) shows level + rationale.
- Deferred: wiring risk into the Policy Engine gate (escalate critical-region writes to `ask`) and attaching risk to every planned step — these change the safety path and are a separate milestone.

#### M14 — Preservation Layer ✅ (advisory slice)
- Goal: distinguish intentional from accidental complexity; protect project identity.
- Build: classifier for intentional complexity vs tech debt and business-critical vs unnecessary abstraction (uses M11 philosophy + M9 criticality + M16 decisions when present). Gate that blocks "generic best-practice" rewrites of intentional structures.
- Deps: M11, M13. Exit: a proposed refactor of an intentional abstraction is blocked with a stated reason; accidental complexity is still flagged.
- Shipped: pure `assessPreservation` (`src/cognition/preservation.ts`) → complexity (intentional/accidental/unclear) × abstraction value (business-critical/incidental/unclear) → disposition `preserve` | `caution` | `allow`. A structure-stripping change (`simplify`/`remove-abstraction`/`rewrite`) of an intentional/business-critical structure is **preserved with a stated reason**; a never-modify zone is always preserved; a god module is treated as accidental (its complexity is the problem). `/preserve <file> [change]` (`cmdPreserve`); M21 consults it to gate every proposal.
- Deferred: turning the `preserve` verdict into a hard write-block in the loop (advisory only — the safety path changes under its own review, like M13).

#### M15 — Temporal Evolution ✅
- Goal: model the repository over time and predict architectural risk.
- Build: time-series over git history + journal — architecture drift, coupling growth, complexity trajectory, tech-debt accumulation, module stability over time. Surface trends + risk forecast in `doctor`.
- Deps: M12. Exit: `doctor` shows drift/coupling trend lines; flags modules trending toward god-object status.
- Shipped: pure `analyzeEvolution(commits, model)` (`src/sensing/evolution.ts`) ranks modules by **churn × coupling** from `git log --name-only` and flags entangled-both-ways modules under heavy churn as god-object-trending (pre-threshold). `health_history` snapshot table (`store.ts`, appended by `init` only when the fingerprint `inputHash` changes) gives the health trend line. `doctor` surfaces both (trend ▲/▼ over last 2 scans + god-trending count); full report via the new `/evolution` command. Read-only git + no new deps; journal time-series deferred (git churn carries the M15 exit signal).

#### M16 — Decision Intelligence (ADR-native) ✅
- Goal: capture *why* decisions exist and keep them current.
- Build: auto-generate ADR snapshots after major changes; decision memory (why / tradeoffs / what was rejected / constraints). Recall feeds the Context Compiler and Preservation Layer.
- Deps: M10, M15. Exit: a significant merged change proposes an ADR snapshot; decision memory is queryable.
- Shipped: pure `src/memory/decisions.ts` — `parseAdr` (id/title/status/date + Context/Decision/Consequences/Alternatives sections), `matchesQuery`, `decisionContent` (why/tradeoffs/rejected), `assessSignificance(commit, model)` (flags a change touching a core/god module or broad in files/modules, criticality from the M9 model), `proposeAdr` (drafts a **`proposed`-status** ADR — never files it; the proposed→accepted gate stays human, per ADR-0008). `init` ingests `docs/adr/NNNN-*.md` into the **semantic memory tier as pinned/confirmed** records (queryable via `memory list semantic`/recall; ready for the M17 Context Compiler). `/decisions [query|propose]` (`cmdDecisions`): list/substring-query decision memory · `propose` drafts an ADR for the latest significant commit. Read-only; no new deps.
- Deferred: a git merge-hook to auto-trigger `propose` on merge (the proposal logic is wired; the trigger is operator-invoked for now).

### Phase C — Autonomy (constrained, conservative)

#### M17 — Context Compiler v2 ✅
- Goal: intent-aware, minimal, intelligent context packets — never the whole repo.
- Build: decompose task intent → resolve bounded-context scope (M9), related symbols, dependency neighborhood, historical decisions (M16), architecture rules, risk profile (M13), test-coverage relevance, change-impact surface. Upgrade `ContextService`.
- Deps: M9, M13, M16. Exit: context for a task is scoped to its bounded context + impact surface and stays within budget with provenance.
- Shipped: pure `src/sensing/context-scope.ts` — `decomposeIntent` (goal → distinct ≥3-char non-stopword terms), `resolveScope` (seed symbols by name/file match → seed modules (M9 `moduleOf`) → import-neighbor lift via M8.5 `file_edges` → in-scope working set). `ContextService` upgraded: assembles an **intent-scoped** packet (bounded context + the seeds' blast-radius **impact surface** via `SymbolGraph`), renders in-scope symbols first (tagged `*`) then backfills by global PageRank within budget, and returns a `scope` provenance field (bounded context, matched terms, impact-surface count). Header `# Context for: …` (scoped) vs `# Repo map for: …` (global fallback when the goal names nothing). `runtime.context()` now also recalls **pinned ADRs the goal names** from semantic memory (M16→M17 bridge: "recall feeds the Context Compiler"), ordered after prior-runs and before the repo map. Plane layering held: cognition/risk stays out of Sensing (sensing→cognition edge forbidden); risk-profile/test-coverage injection deferred (needs M13 wire / M19). No new deps.

#### M18 — Agent Factory ✅
- Goal: project-native agents generated from the detected stack — never hand-coded.
- Build: generation pipeline that emits agents (e.g. routing/query/boundary-enforcer/dependency-cleanup/perf agents) from M8 stack + M13 constraints; each agent carries rules, memory-access scope, risk constraints, allowed actions, hooks, workflows. New CLI `agents`.
- Deps: M8, M13. Exit: `agents` lists generated agents matching the repo's stack; each respects its risk/memory scope.
- Shipped: pure `generateAgents` (`src/cognition/agent-factory.ts`) → framework agents (`nextjs-routing-agent`, `state-management-agent`, `api-contract-agent`), structural agents (`architecture-review-agent` always; `feature-boundary-enforcer` for sliced/DDD; `dependency-cleanup-agent` when cycles/god-modules exist), stack agents (`testing-agent`). Each `AgentSpec` carries triggers, rules, module scope, broker capabilities, and a risk-escalation ceiling; ids are de-duplicated and order-stable. `/agents` (`cmdAgents`). No new deps.
- Runtime binding shipped: `src/cognition/agent-runtime.ts` — `selectAgent(agents, goal)` (pure fit-score over id/trigger/scope/rule overlap; falls back to the read-only `architecture-review-agent`) + `agentBriefing(spec)` (renders the mandate as a planner preamble → **spec→prompt**). `effecting/agent-broker.ts` `AgentBroker` extends the CapabilityBroker and overrides the single `request` gate to **deny any action outside the spec's capabilities before policy** (tighten-never-widen, ADR-0003) → **spec→authority**. `runtime.loop(agent?)` runs the executor under that scoped broker (transaction/verifier stay trusted). `/agent [--run] <goal>` (`cmdAgentRun`): selects the agent, plans under its briefing, and with `--run` executes through the capability-scoped loop — a read-only agent plans but its writes are denied, so the worktree discards.

#### M19 — Autoskills v2 + Hooks Engine 🟡 (hooks engine shipped)
- Goal: skills become executable, multi-phase, gated workflows.
- Build: skill runtime with phases analyze → simulate → validate → execute → rollback (e.g. `safe-refactor`, `dependency-cleanup`, `architecture-review`). Hooks engine enforcing pre (forbidden-import, boundary, dependency-constraint) and post (lint, typecheck, test, regression, bundle) checks via the broker.
- Deps: M13, M14. Exit: `safe-refactor` runs all phases; a forbidden-import pre-hook blocks a bad change before write.
- Shipped: pure `evaluatePreHooks` (`src/effecting/hooks.ts`) — the static pre-write gate: **never-modify** (write into a sensitive zone → block), **forbidden-import** (an added edge that closes a module cycle → block, via reachability over the existing module graph), **boundary-leak** (cross-module import past the public surface → warn). `postHookChecks(fingerprint)` derives the post-write checks the stack implies (typecheck + the detected test runner). `/hooks` (`cmdHooks`) introspects both. `effecting` stays self-contained (inlined `moduleOf`, no sensing import).
- Pre-write gate now wired into the loop: `runtime.preApply` resolves the import edges the planned writes would add (M8.5 resolver + indexed edge set) and runs `evaluatePreHooks`; `CognitionLoop.run` aborts on any `block` finding **before opening a worktree** (journals `plan`→`verdict`→`decision`, nothing written) — unbypassable for every loop run (`/run`, `/agent --run`, `/refactor`), not just per-command. It can only refuse, never grant authority the broker wouldn't.
- Deferred: the multi-phase executable skill runtime (analyze→simulate→validate→execute→rollback).

#### M20 — Execution Simulation Engine 🟡 (engine shipped)
- Goal: predict impact before applying, not only verify after.
- Build: pre-apply simulation of dependency propagation, type-system impact, API-contract drift, test-failure probability, boundary violations. No real change without simulation validation (unless overridden).
- Deps: M17, M19. Exit: a high-risk step shows predicted blast radius + test-failure probability before any worktree write.
- Shipped: pure `simulateExecution` (`src/cognition/simulation.ts`) — composes M9 cycles + M13 risk/confidence + M14 preservation + M15 churn + the symbol graph's reverse-reachability into one pre-apply prediction: **dependency propagation** (downstream symbols/files/modules), **type-system impact** (downstream importers), **API-contract drift** (other modules depending on the changed surface), **boundary state** (target module in a cycle), and a **regression-probability** estimate (`hazard` = reach + criticality + volatility, scaled by test-coverage `exposure`). Yields an advisory autonomy verdict `auto` | `review` | `block` (block on never-modify / preserve; review on high risk / regression ≥ 0.6 / preservation caution / cyclic boundary). `/simulate <file> [change]` (`cmdSimulate`); the regression estimate names every factor so the prediction is auditable. No new deps.
- Deferred: turning the verdict into a **hard pre-apply gate** on the loop's worktree write path (the M20→loop wire, alongside the deferred M13/M14 gating and the M19 pre-hook wire) — shipped as advisory, like risk/preservation, so it never silently blocks until that path is safety-reviewed.

#### M21 — Autonomous Improvement (`improve` / `refactor` / migration `plan`) ✅ (`improve` + `refactor` shipped)
- Goal: conservative evolution — better repo, preserved identity.
- Build: `improve` (safe migration plans, ADR suggestions, dependency cleanup, perf, modularization, testing-gap proposals); `refactor` (constrained execution through M19/M20); engineering-economics gate (cost-of-change / maintenance overhead / ROI) to avoid over-engineering.
- Deps: M14, M19, M20. Exit: `improve` proposes ranked, ROI-gated changes that never touch NEVER-MODIFY zones; `refactor` applies one through the simulation+hooks+worktree path.
- Shipped: pure `proposeImprovements` (`src/cognition/improve.ts`) maps each M12 violation to a conservative, structure-preserving action (`break-cycle`, `decompose`, `realign-dependency`, `add-tests`), scores ROI = impact / effort, and ranks. Every proposal is gated through the M14 Preservation Layer (`protectedModules` in the command): a module ruled `preserve` (intentional / never-modify) is reported as **preserved, not auto-proposed**. `/improve` (`cmdImprove`). Read-only — it proposes; it never applies.
- `refactor` shipped (`cmdRefactor`, `/refactor [--pick N] [--force]`): takes the top-ranked `improve` proposal (or `--pick N`), resolves a representative source file in the subject module, and runs it through the **M20 execution-simulation + M14 preservation pre-apply gate** (`assembleSimulation`, shared with `simulate`) — a `block` verdict refuses outright, a `review` verdict needs explicit `--force` (the human gate, constrained autonomy). If allowed, it executes under the best-fit, **capability-scoped agent** (`selectAgent` + `loop(agent)`, M18) through the same worktree transaction as every loop run, so a failing verify discards it — nothing is applied blindly. Reuses the agent broker's capability scoping for "constrained execution".
- Deferred: the explicit engineering-economics ROI *ceiling* beyond value/effort, and turning the simulation gate into an unbypassable check inside the loop itself (it gates at the `refactor` command today; making it loop-internal is the same safety-path wire as M13/M19/M20).

### Phase D — Infrastructure

#### M22 — Daemon Runtime (`watch`) 🟡 (in-process poller shipped)
- Goal: continuous intelligence without re-running commands.
- Build: `archon watch` daemon — FS watcher → git-diff/AST-aware incremental re-index of only the affected graph segment; symbol-level cache; background low-cost analysis.
- Deps: M8, M12. Exit: editing one file re-indexes only its subtree live; violations refresh in the background.
- Shipped: pure `src/sensing/watch.ts` — `changedSince(prev, curr)` diffs consecutive dirty snapshots (entered/left/quiet) and `formatWatchTick` renders the one-line delta. `cmdWatch(rt, prev)` runs one incremental tick: reindex the git-dirty set (hash-gated by the Indexer, so only content-changed files reparse — never a full rescan), and when the set moved, recompute the M12 health score and print. `/watch` runs a single tick on demand; `/watch --loop` starts an unref'd in-process background poller (2s) in the line shell that reindexes + refreshes health without re-running a command, `/watch --stop` ends it. `dirtyPaths` now degrades to `[]` outside a git repo, like `commitHistory`.
- Deferred: a real FS-event watcher (vs git-status polling), AST-segment-level invalidation, and `--loop` inside the full-screen TUI render loop (the line shell carries the daemon for now; the TUI gets the single-tick `/watch`).

#### M23 — Provider Orchestration completion ✅
- Goal: route each task to the provider that fits it.
- Build: add Gemini + local-model provider clients; task-based routing (Claude → architecture reasoning / deep context, OpenAI → structured tool execution, Gemini → large-repo ingestion, local → cheap background analysis).
- Deps: M7. Exit: a large-ingestion task routes to Gemini, a background scan to a local model, with fallback.
- Done: `@ai-sdk/google` added; `createAiClient` now covers `anthropic | openai | google | local` — Gemini via the Google generative-language endpoint, `local` reusing the OpenAI chat protocol against a configurable base URL (`ARCHON_LOCAL_BASE_URL`, default `http://localhost:11434/v1`, keyless). Catalog gains `gemini-2.0-flash` (1M ctx) + `gemini-1.5-pro` (2M ctx); `local` model ids are user-named and synthesized free (cost 0). Runtime `PROVIDER_ENV`/`KEYLESS_PROVIDERS`/`providerStatus` updated; the router's existing strength-scored selection + budget breaker + fallback chain now spans all four. Tests inject `fetch` — no real network (Gemini-endpoint + local-baseURL routing asserted; `resolveModels` catalog + local-synthesis covered).

#### M24 — Rust core: tree-sitter + vector store ⬜
- Goal: production-grade parsing + semantic memory.
- Build: replace the heuristic symbol extractor with tree-sitter (or ts-morph for TS) for accurate symbol/dependency graphs; persist a vector index for semantic memory/retrieval.
- Deps: M1. Exit: symbol graph matches a tree-sitter parse; semantic recall uses the persisted vector index.

---

## 3. MVP cut vs. full production

Not all 17 milestones are needed to demonstrate the thesis. Suggested cut:

- **Intelligence MVP** (proves "project-native, not generic"): M8 → M9 → M10 → M12.
  Deliverable: `init` understands the repo, `boundaries` + `violations` make it
  observable, and project memory files are generated.
- **Governance MVP** (proves "preserves architecture, constrained autonomy"):
  + M13 → M14 → M17. Risk-scaled autonomy + preservation + intent-scoped context.
- **Autonomy MVP** (proves "conservative evolution"): + M19 → M21. One real
  `safe-refactor` / `improve` flow end-to-end.
- **Production**: M11, M15, M16, M18, M20, M22, M24 — depth, prediction,
  generated agents, daemon, full provider mesh, accurate parsing.

## 4. Critical path

```
M8 ─┬─ M9 ─┬─ M10 ─── M16 ─┐
    │      ├─ M12 ─── M15   ├─ M17 ─── M20 ─┐
    │      └─ M13 ─── M14 ──┴───────────────┴─ M19 ─── M21
    ├─ M11 ─ (M14)
    ├─ M18
    └─ M22
M7 ─ M23     M1 ─ M24
```

M8 is the keystone — almost everything depends on the architectural fingerprint.
Start there.
