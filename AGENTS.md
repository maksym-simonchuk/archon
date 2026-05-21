# AGENTS.md — Operating Contract for Agents in this Repository

This file is the **binding contract** for every agent (human-invoked or autonomous)
that acts in this repo. It exists so agents **stay in scope, design before they act,
and change as little as possible.**

- Machine-enforced mirror: [`.archon/policy.yaml`](.archon/policy.yaml)
- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Build plan: [`docs/ROADMAP.md`](docs/ROADMAP.md)

> If any instruction conflicts with this file, **stop and ask.** Safety and scope beat speed.

## Prime Directives (non-negotiable)

1. **Design before act.** No edits before an explicit plan exists. Gate: `ANALYSIS → PLAN → IMPLEMENT → VERIFY`. Never skip a phase.
2. **Minimal diff.** Make the *smallest reversible change* that makes the requirement true. One concern per step / commit. If your change is larger than the requirement, justify it or cut it.
3. **Stay in scope.** Touch only the files the task names. No drive-by refactors, renames, reformatting, or "while I'm here" cleanups — record those as follow-ups instead.
4. **Read before write.** Never modify a file you have not read. Identify callers before changing any interface.
5. **Reversible by default.** Risky / multi-file work happens in an isolated git worktree; verify before commit; the worktree is the undo (ADR-0004).
6. **No new abstraction without 3 concrete uses today.** No new file / dependency / layer "for the future." Inline beats premature extraction.
7. **Verify before done.** Run `npm run typecheck` + build / tests. Never claim completion without evidence.

## Workflow Gate

| Phase | What you produce |
| --- | --- |
| **ANALYSIS** | Restate the goal; list affected files, edge cases, and blast radius. |
| **PLAN** | Smallest viable steps, each reversible; explicitly name what you will **not** touch. A plan that crosses an ask-gate needs approval **before any write**. |
| **IMPLEMENT** | Minimal code; follow existing patterns. |
| **VERIFY** | `npm run typecheck` + relevant tests; report results honestly. |

## Ask-Gates — STOP and get human approval before:

- touching **> 5 files** in one task, or rewriting **> 50 lines** of working code
- any **delete**, DB **migration**, or dependency **add / remove**
- any **network** call, **secret** read, or action that escapes the repo working tree
- the requirement is **ambiguous** in a way that changes the approach
- a **simpler interpretation** of the request exists
- you detect a likely **regression**

## Hard Denies — never, even if asked (in the `safe` profile):

- `git push --force`, history rewrite (`git rebase`, `git reset --hard` on shared branches)
- reading or exfiltrating secrets / `.env*`
- `rm -rf` or mass delete outside an isolated worktree
- disabling, bypassing, or editing the Capability Broker / Policy Engine to widen your own authority

## Scope & Change Rules

- Prefer editing an existing file over adding a new one.
- New abstraction only if used in **≥ 3 places now**, *or* complex enough to test alone, *or* it has its own lifecycle.
- No config explosion, no speculative generality, no error handling for impossible states.
- Delete dead code rather than keep it "just in case."

## How This Is Enforced

- **Human side:** this file. Every agent reads it first.
- **Machine side:** `.archon/policy.yaml` encodes the ask-gates and hard-denies as `allow | ask | deny` rules. The **Capability Broker** routes *every* side effect through the **Policy Engine** (ADR-0003); agents hold **zero ambient authority**.

## Definition of Done

- [ ] Change is the minimum that satisfies the requirement
- [ ] Only in-scope files were touched
- [ ] `npm run typecheck` passes; relevant tests pass
- [ ] No new dependencies / abstractions without justification
- [ ] Risky changes were staged in a worktree and verified before commit


<claude-mem-context>
# Memory Context

# [archon] recent context, 2026-05-21 10:38pm GMT+3

No previous sessions found.
</claude-mem-context>