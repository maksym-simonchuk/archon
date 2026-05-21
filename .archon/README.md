# .archon/

Runtime state + policy for the Archon runtime.

| Path          | Tracked? | Purpose                                                    |
| ------------- | -------- | ---------------------------------------------------------- |
| `policy.yaml` | ✅ yes   | Machine-enforced safety policy (mirrors `AGENTS.md`).      |
| `journal/`    | ❌ no    | Append-only task journal (resume + audit).                 |
| `memory/`     | ❌ no    | Episodic / semantic / procedural memory store.             |
| `cache/`      | ❌ no    | Hash-keyed summary + prompt cache.                         |

Only `policy.yaml` and this README are committed; runtime state is gitignored.
