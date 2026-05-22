import type { BoundaryModel } from '../sensing/boundaries';
import { moduleOf } from '../sensing/boundaries';
import type { Commit } from '../sensing/evolution';

/**
 * Decision intelligence (M16): treat the ADRs in `docs/adr/` as first-class
 * decision memory — the durable record of *why* the architecture is the way it
 * is (the choice, its tradeoffs, what was rejected). Pure: parse markdown into
 * structured decisions, match them against a query, and draft a *proposed* ADR
 * for a significant change. The fs read, semantic-memory ingestion (so recall
 * can feed the Context Compiler) and CLI wiring live in `init` / the command.
 *
 * Proposing never accepts: a draft is emitted for a human to complete and file,
 * mirroring the ADR README's `proposed → accepted` gate and ADR-0008's
 * human-gated promotion. Nothing here writes.
 */

export type AdrStatus = 'proposed' | 'accepted' | 'superseded' | 'unknown';

export interface Decision {
  /** Zero-padded ADR id, e.g. `0003`. */
  id: string;
  title: string;
  status: AdrStatus;
  date?: string;
  /** Section bodies (trimmed; '' when the section is absent). */
  context: string;
  decision: string;
  consequences: string;
  /** The "## Alternatives considered" body — what was rejected and why. */
  alternatives: string;
  /** Source file, repo-relative. */
  file: string;
}

const STATUSES: AdrStatus[] = ['proposed', 'accepted', 'superseded'];

/** Parse one ADR markdown file into a structured decision. */
export function parseAdr(markdown: string, file: string): Decision {
  const lines = markdown.split('\n');
  const heading = lines.find((l) => l.startsWith('# ')) ?? '';
  const headingText = heading.replace(/^#\s*/, '').trim();
  const idMatch = headingText.match(/^(\d{1,4})/) ?? file.match(/(\d{1,4})/);
  const id = idMatch ? idMatch[1].padStart(4, '0') : '????';
  const title = headingText.replace(/^\d{1,4}\s*[—–-]\s*/, '').trim() || headingText;

  const meta = (label: string): string | undefined => {
    const row = lines.find((l) => l.trim().toLowerCase().startsWith(`- ${label.toLowerCase()}:`));
    return row?.slice(row.indexOf(':') + 1).trim();
  };
  const statusRaw = (meta('Status') ?? '').toLowerCase();
  const status: AdrStatus = STATUSES.find((s) => statusRaw.startsWith(s)) ?? 'unknown';

  return {
    id,
    title,
    status,
    date: meta('Date'),
    context: section(lines, 'Context'),
    decision: section(lines, 'Decision'),
    consequences: section(lines, 'Consequences'),
    alternatives: section(lines, 'Alternatives considered'),
    file,
  };
}

/** The body of a `## <name>` section, up to the next `##` header (trimmed). */
function section(lines: string[], name: string): string {
  const start = lines.findIndex((l) => /^##\s/.test(l) && l.replace(/^##\s*/, '').trim().toLowerCase() === name.toLowerCase());
  if (start === -1) return '';
  const body: string[] = [];
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) body.push(lines[i]);
  return body.join('\n').trim();
}

/** Case-insensitive substring match across the decision's title + bodies. */
export function matchesQuery(d: Decision, query: string): boolean {
  const q = query.toLowerCase();
  return [d.title, d.context, d.decision, d.alternatives].some((s) => s.toLowerCase().includes(q));
}

/** Compact decision-memory content (why / tradeoffs / rejected) for the semantic tier. */
export function decisionContent(d: Decision): string {
  const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
  return [
    `ADR-${d.id} [${d.status}] ${d.title}`,
    d.decision && `why: ${oneLine(d.decision)}`,
    d.consequences && `tradeoffs: ${oneLine(d.consequences)}`,
    d.alternatives && `rejected: ${oneLine(d.alternatives)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatDecisions(decisions: Decision[], query?: string): string {
  if (decisions.length === 0) {
    return query ? `decisions: no ADR matches "${query}"` : 'decisions: no ADRs found under docs/adr/';
  }
  const head = query
    ? `decisions: ${decisions.length} ADR(s) matching "${query}":`
    : `decisions: ${decisions.length} recorded:`;
  const lines = [head];
  for (const d of decisions) {
    const why = d.decision.replace(/\s+/g, ' ').trim().slice(0, 80);
    lines.push(`  ADR-${d.id} [${d.status}] ${d.title}`);
    if (why) lines.push(`    why: ${why}${why.length === 80 ? '…' : ''}`);
  }
  return lines.join('\n');
}

// --- ADR proposal for a significant change -------------------------------

/** A change touches enough criticality/breadth that its rationale ought to be recorded. */
const SIGNIFICANT_FILES = 5;
const SIGNIFICANT_MODULES = 3;

export interface Significance {
  significant: boolean;
  reason: string;
  /** Touched modules ranked by criticality (most load-bearing first). */
  touchedModules: { name: string; coupling: number; role: string }[];
  fileCount: number;
}

/**
 * Decide whether a commit warrants an ADR: it does when it reaches into a
 * load-bearing module (core or god-module) or is broad (many files / many
 * modules). Criticality comes from the M9 boundary model.
 */
export function assessSignificance(commit: Commit, model: BoundaryModel): Significance {
  const byName = new Map(model.modules.map((m) => [m.name, m] as const));
  const god = new Set(model.godModules.map((g) => g.name));
  const touched = [...new Set(commit.files.map(moduleOf))]
    .map((name) => {
      const m = byName.get(name);
      return { name, coupling: m ? m.fanIn + m.fanOut : 0, role: m?.role ?? 'unknown' };
    })
    .sort((a, b) => b.coupling - a.coupling);

  const hitsCore = touched.some((t) => t.role === 'core' || god.has(t.name));
  const broadFiles = commit.files.length >= SIGNIFICANT_FILES;
  const broadModules = touched.length >= SIGNIFICANT_MODULES;

  const reasons: string[] = [];
  if (hitsCore) reasons.push('touches a load-bearing module (core / god-module)');
  if (broadFiles) reasons.push(`spans ${commit.files.length} files`);
  if (broadModules) reasons.push(`spans ${touched.length} modules`);

  return {
    significant: hitsCore || broadFiles || broadModules,
    reason: reasons.join('; ') || 'localized, low-criticality change',
    touchedModules: touched,
    fileCount: commit.files.length,
  };
}

/**
 * Draft a *proposed* ADR for a significant change (status `proposed`, for a human
 * to complete and file). The factual "what changed" context is auto-filled; the
 * decision/consequences/alternatives stay as prompts — the runtime records that a
 * decision was made, not what it should be.
 */
export function proposeAdr(nextId: string, commit: Commit, sig: Significance, date: string): string {
  const mods = sig.touchedModules.slice(0, 6).map((m) => `\`${m.name}\` (coupling ${m.coupling}, ${m.role})`);
  return `# ${nextId} — <title: the decision this change embodies>

- Status: proposed
- Date: ${date}
- Deciders: <names>

## Context

Auto-detected from commit \`${commit.hash.slice(0, 8)}\` — flagged significant because it ${sig.reason}.
Touched modules (most load-bearing first):
${mods.length ? mods.map((m) => `- ${m}`).join('\n') : '- (none resolved against the boundary model)'}

<Complete: what forces/constraints drove this change?>

## Decision

<Complete: the choice this change embodies, in active voice.>

## Consequences

- Positive: …
- Negative / cost: …
- Risk removed: …

## Alternatives considered

- <option> — rejected because …
`;
}
