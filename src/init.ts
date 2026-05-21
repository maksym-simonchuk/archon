import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Canonical default `safe` policy — mirrors AGENTS.md (read freely, write
// narrowly, ask on risk, deny destructive). This is the seed a fresh repo gets;
// projects then tune it. Kept in sync with the repo's own .archon/policy.yaml.
const POLICY_YAML = `# Machine-enforced safety policy. Mirrors AGENTS.md.
# The Capability Broker evaluates every side effect against the active profile.
# See ADR-0003 (single broker) and ADR-0010 (safe-by-default).
version: 0
active_profile: safe

defaults:
  # Anything not explicitly allowed is denied (default-deny, esp. outside the repo).
  decision: deny

profiles:
  safe:
    description: Default. Read freely, write narrowly, ask on risk, deny destructive.
    allow:
      - { action: fs.read, target: "**" }
      - { action: fs.write, target: "**", when: { blast_radius_files_max: 5 } }
      - { action: exec, target: ["npm", "node", "tsc", "tsx", "git status", "git diff", "git add", "git commit"] }
    ask:
      - { action: fs.write, when: { blast_radius_files_exceeds: 5 } }
      - { action: fs.write, when: { lines_changed_min: 50 } }
      - { action: fs.delete }
      - { action: exec, target: ["git checkout", "git merge", "git worktree"] }
      - { action: net }                       # any network egress
    deny:
      - { action: exec, target: ["git push --force", "git push -f", "git reset --hard", "git rebase", "rm -rf"] }
      - { action: secret.read, target: ["**/.env*", "**/secrets/**", "**/*.pem", "**/id_rsa*"] }
      # Secrets are not reachable via the ordinary fs.read grant either — the
      # broad \`fs.read: **\` allow above must not become a secret-exfil path.
      - { action: fs.read, target: ["**/.env*", "**/secrets/**", "**/*.pem", "**/id_rsa*"] }

  trusted:
    description: Higher autonomy inside an isolated worktree. Destructive class still denied.
    inherits: safe
    allow:
      - { action: fs.write, target: "**", when: { in_worktree: true } }
      - { action: exec, target: ["git checkout", "git merge", "git worktree", "git push"] }

# Hard limits, independent of profile. Exceeding always escalates to ask/deny.
limits:
  blast_radius_files_max: 25
  per_task_usd: 2.00
  global_daily_usd: 25.00
  context_tokens_max: 60000
`;

const ARCHON_README = `# .archon/

Runtime state + policy for the Archon runtime.

| Path          | Tracked? | Purpose                                                    |
| ------------- | -------- | ---------------------------------------------------------- |
| \`policy.yaml\` | ✅ yes   | Machine-enforced safety policy (mirrors \`AGENTS.md\`).      |
| \`journal.db\`  | ❌ no    | Append-only task journal (resume + audit).                 |
| \`memory.db\`   | ❌ no    | Episodic / semantic / procedural memory store.             |
| \`index.db\`    | ❌ no    | Incremental symbol/file index.                             |

Only \`policy.yaml\` and this README are committed; runtime state is gitignored.
`;

// Starter config mirrors the built-in defaults; add a provider entry + set its
// API key in the environment to switch planning from the offline scaffolder to
// the LLM planner.
const CONFIG_JSON = `${JSON.stringify(
  {
    profile: 'safe',
    providers: [],
    routing: { fallback: [] },
    budgets: { perTaskUsd: 2, globalDailyUsd: 25, contextTokensMax: 60_000 },
  },
  null,
  2,
)}\n`;

/**
 * Scaffold a repo for Archon: write the default safe policy, the `.archon`
 * README, and a starter `archon.config.json`. This is host bootstrap — it writes
 * directly (the Capability Broker can't gate the very file that defines it). It
 * refuses to clobber an existing policy, so re-running on a configured repo is a
 * no-op.
 */
export async function cmdInit(root: string): Promise<void> {
  const policyPath = join(root, '.archon', 'policy.yaml');
  if (existsSync(policyPath)) {
    console.log('archon: already initialized (.archon/policy.yaml exists) — leaving it untouched');
    return;
  }

  await mkdir(join(root, '.archon'), { recursive: true });
  await writeFile(policyPath, POLICY_YAML);
  await writeFile(join(root, '.archon', 'README.md'), ARCHON_README);

  const configPath = join(root, 'archon.config.json');
  if (!existsSync(configPath)) await writeFile(configPath, CONFIG_JSON);

  console.log('archon: initialized .archon/policy.yaml + .archon/README.md + archon.config.json');
  console.log('next: `archon plan "<goal>"` (offline scaffolder), or add a provider to');
  console.log('      archon.config.json + set its API key in the env for LLM planning.');
}
