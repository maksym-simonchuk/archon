import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { decisionContent, parseAdr } from './memory/decisions';
import {
  PROJECT_MEMORY_PATH,
  extractHash,
  contentHash,
  renderProjectMemory,
} from './memory/project-memory';
import { MemoryStore } from './memory/store';
import { type BoundaryModel, inferBoundaries } from './sensing/boundaries';
import { IndexStore } from './sensing/store';
import { analyzeStructure, formatFingerprint } from './sensing/structural-analyzer';
import { detectViolations } from './sensing/violations';
import type { ArchitecturalFingerprint } from './core/types';

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

// Commented sample mcp.yaml — written as `.archon/mcp.yaml.example` so the
// outbound MCP config layer is discoverable without enabling anything by
// default. Loader treats a missing file as `{ servers: [] }`; the example
// stays inert until the user copies + uncomments it AND grants `mcp:*` in
// policy.yaml. *Configured ≠ authorized* — that's the M30/ADR-0015 invariant.
const MCP_YAML_EXAMPLE = `# .archon/mcp.yaml — outbound MCP server registry (optional).
#
# Each entry lists a child-process MCP server Archon can call out to. The
# policy at .archon/policy.yaml still gates every call by
# \`mcp:<server>:<tool>\` (default-deny per ADR-0015 #4); a server here is
# *configured*, not yet *authorized*. To enable: copy this file to
# mcp.yaml, uncomment the entries you want, and grant the matching
# capability under \`v2_capabilities.mcp\` in policy.yaml.
#
# servers:
#   - id: claude-code
#     command: claude-mcp
#     args: [--stdio]
#     env:
#       FOO: bar
#   - id: cursor
#     command: cursor-mcp
`;

const ARCHON_README = `# .archon/

Runtime state + policy for the Archon runtime.

| Path          | Tracked? | Purpose                                                    |
| ------------- | -------- | ---------------------------------------------------------- |
| \`policy.yaml\`         | ✅ yes   | Machine-enforced safety policy (mirrors \`AGENTS.md\`).      |
| \`mcp.yaml.example\`    | ✅ yes   | Sample outbound MCP config — copy to \`mcp.yaml\` to enable. |
| \`mcp.yaml\`            | ❌ no    | Outbound MCP server registry (optional, gitignored).        |
| \`journal.db\`          | ❌ no    | Append-only task journal (resume + audit).                 |
| \`memory.db\`           | ❌ no    | Episodic / semantic / procedural memory store.             |
| \`index.db\`            | ❌ no    | Incremental symbol/file index.                             |

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
 * Scaffold a repo for Archon and run the structural deep scan (M8): write the
 * default safe policy, the `.archon` README, and a starter `archon.config.json`,
 * then analyze the repository and persist its architectural fingerprint.
 *
 * This is host bootstrap — it writes directly (the Capability Broker can't gate
 * the very file that defines it). The scaffold step refuses to clobber an
 * existing policy/config, but the analysis runs on every `init` so re-running
 * refreshes the fingerprint; the analyzer's `inputHash` makes an unchanged repo
 * a persist-skipping no-op.
 */
export async function cmdInit(root: string): Promise<void> {
  const policyPath = join(root, '.archon', 'policy.yaml');
  const freshlyInitialized = !existsSync(policyPath);
  if (freshlyInitialized) {
    await mkdir(join(root, '.archon'), { recursive: true });
    await writeFile(policyPath, POLICY_YAML);
    await writeFile(join(root, '.archon', 'README.md'), ARCHON_README);
    // mcp.yaml.example documents the outbound-MCP config layer; the actual
    // mcp.yaml stays absent so a fresh repo defaults to the empty server
    // registry (the policy already default-denies every mcp:* cap).
    await writeFile(join(root, '.archon', 'mcp.yaml.example'), MCP_YAML_EXAMPLE);

    const configPath = join(root, 'archon.config.json');
    if (!existsSync(configPath)) await writeFile(configPath, CONFIG_JSON);

    console.log('archon: initialized .archon/{policy.yaml, README.md, mcp.yaml.example} + archon.config.json');
  } else {
    console.log('archon: already initialized (.archon/policy.yaml exists) — leaving it untouched');
  }

  await analyzeAndPersist(root);
  await ingestDecisions(root);

  if (!freshlyInitialized) return;
  console.log('next: `archon plan "<goal>"` (offline scaffolder), or add a provider to');
  console.log('      archon.config.json + set its API key in the env for LLM planning.');
}

/**
 * Run the structural analysis and persist the fingerprint to the index, skipping
 * the write when the repo is unchanged since the last scan (`inputHash` match).
 */
async function analyzeAndPersist(root: string): Promise<void> {
  const fingerprint = await analyzeStructure(root);
  const store = new IndexStore(join(root, '.archon', 'index.db'));
  try {
    const unchanged = store.getFingerprint()?.inputHash === fingerprint.inputHash;
    if (!unchanged) store.saveFingerprint(fingerprint);
    console.log(`archon: structural fingerprint${unchanged ? ' (unchanged)' : ''}`);
    console.log(formatFingerprint(fingerprint));

    const model = inferBoundaries(store.allFileHashes(), store.loadFileEdges());
    store.saveModuleIntelligence(model);
    if (!unchanged) recordHealthSnapshot(store, model, fingerprint); // M15 trend point
    await generateProjectMemory(root, fingerprint, model);
  } finally {
    store.close();
  }
}

/**
 * Append one architecture-health reading to the time series (M15), keyed on the
 * fingerprint's `inputHash`. Recorded only when the repo-state changed, so the
 * history is one point per distinct indexed state — that sequence is the trend
 * `doctor` reads back.
 */
function recordHealthSnapshot(store: IndexStore, model: BoundaryModel, fingerprint: ArchitecturalFingerprint): void {
  const definedFiles = new Set(store.allSymbols().map((s) => s.file));
  const { healthScore, countsBySeverity } = detectViolations({
    model,
    files: store.allFileHashes(),
    edges: store.loadFileEdges(),
    definedFiles,
  });
  store.appendHealthSnapshot({
    ts: new Date().toISOString(),
    inputHash: fingerprint.inputHash,
    score: healthScore,
    ...countsBySeverity,
  });
}

/**
 * Generate the project-native memory file (M10) from the fingerprint + the
 * boundary model (derived and persisted by the caller). The boundary sections
 * are empty until the repo has been indexed (`archon index`), so re-running
 * `init` after an index refreshes them. Diff-aware: an unchanged file is left
 * untouched.
 *
 * Direct fs write is the same bootstrap exception the policy/fingerprint use.
 */
async function generateProjectMemory(
  root: string,
  fingerprint: ArchitecturalFingerprint,
  model: BoundaryModel,
): Promise<void> {
  const path = join(root, PROJECT_MEMORY_PATH);
  const existing = existsSync(path) ? await readFile(path, 'utf8') : undefined;
  if (existing !== undefined && extractHash(existing) === contentHash(fingerprint, model)) {
    console.log('archon: project memory (unchanged)');
    return;
  }
  await writeFile(path, renderProjectMemory(fingerprint, model));
  console.log(`archon: project memory → ${PROJECT_MEMORY_PATH}`);
}

/**
 * Ingest the repo's ADRs (`docs/adr/NNNN-*.md`) into the semantic memory tier as
 * pinned, confirmed records (M16) — decision memory the runtime can recall and
 * (M17) the Context Compiler can pull. Idempotent: keyed `adr:<id>`, so re-`init`
 * overwrites in place. No-op when the repo has no ADRs, so a fresh `init` on an
 * arbitrary repo creates no memory store. Bootstrap fs read + memory write, the
 * same exception the policy/fingerprint use.
 */
async function ingestDecisions(root: string): Promise<void> {
  const adrDir = join(root, 'docs', 'adr');
  if (!existsSync(adrDir)) return;
  const files = (await readdir(adrDir)).filter((f) => /^\d{1,4}.*\.md$/.test(f)); // numbered ADRs only
  if (files.length === 0) return;

  const store = new MemoryStore(join(root, '.archon', 'memory.db'));
  try {
    for (const f of files) {
      const d = parseAdr(await readFile(join(adrDir, f), 'utf8'), posix.join('docs/adr', f));
      store.write(
        {
          id: `adr:${d.id}`,
          tier: 'semantic',
          key: d.title,
          content: decisionContent(d),
          createdAt: new Date().toISOString(),
          confirmed: true,
        },
        { pinned: true },
      );
    }
    console.log(`archon: decision memory ← ${files.length} ADR(s) (semantic, pinned)`);
  } finally {
    store.close();
  }
}
