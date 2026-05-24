# Architecture Decision Records

Lightweight records of significant decisions. Format: see [`template.md`](template.md).
Status: `proposed` · `accepted` · `superseded by NNNN`.

New ADR = next number, copy the template, link it from this index. Changing a past
decision = add a new ADR and mark the old one `superseded`.

| #    | Title                                              | Status   |
| ---- | -------------------------------------------------- | -------- |
| 0001 | Record architecture decisions                      | accepted |
| 0002 | Four-plane runtime topology                        | accepted |
| 0003 | Single Capability Broker (zero ambient authority)  | accepted |
| 0004 | Git-worktree transactions                          | accepted |
| 0005 | Incremental indexing — no full rescan              | accepted |
| 0006 | Context compression, not ingestion                 | accepted |
| 0007 | Multi-provider router with fallback                | accepted |
| 0008 | Three-tier memory, human-gated promotion           | accepted |
| 0009 | Plugin ABI v0 (five hooks)                         | accepted |
| 0010 | Safe-by-default profiles + design-before-act       | accepted |
| 0011 | Rust → WASM compute core for hot paths             | accepted |
| 0012 | Provider plugins as a cap-gated router fallback    | accepted |
| 0013 | OpenSpec as plan artifact                          | accepted |
| 0014 | Mastra workflow scope                              | accepted |
| 0015 | Runtime v2 safety invariants                       | accepted |
| 0016 | PatchStore + staged-diff UX                        | accepted |
| 0017 | Bus journal + replay                               | accepted |
| 0018 | BrokerSpecStore + planner emit                     | accepted |
| 0019 | `broker.fsDelete` capability                       | accepted |
