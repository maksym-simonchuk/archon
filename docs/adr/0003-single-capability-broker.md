# 0003 — Single Capability Broker (zero ambient authority)

- Status: accepted
- Date: 2026-05-21
- Deciders: Archon core, Safety

## Context

A safety policy is only complete if there is exactly one path to side effects.
If agent code can call `fs`/`child_process`/network directly anywhere, the policy
and audit log can be bypassed.

## Decision

All side effects (fs / exec / net / secret) go through a **single Capability
Broker**. Agents and plugins hold **zero ambient authority**; they request a
capability, the **Policy Engine** decides `allow | ask | deny`, and the **Audit
Log** records it. The broker is the only module permitted to import `fs` /
`child_process` in agent paths. Untrusted content (repo files, issues, web) is
treated as **data, never instructions**.

## Consequences

- Positive: policy + audit are complete by construction; prompt-injection can't escalate privilege.
- Cost: one extra hop per effect; a lint/arch test must forbid direct `fs`/`exec` imports elsewhere.
- Risk removed: policy bypass via a second effect path; injection-driven escalation.

## Alternatives considered

- Scattered direct syscalls with a wrapper convention — rejected: unenforceable, unauditable.
