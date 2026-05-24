/**
 * Pure-TS validator for OpenSpec change folders. No `fs`, no network — the
 * caller hands us the parsed `OpenSpecChange` (typically from `parseChange`
 * below, fed by the broker-mediated reader). Validation is structural: we
 * catch the shapes that would break downstream consumers (Planner, Verifier,
 * archive). We do not try to enforce English prose quality.
 *
 * See ADR-0013, `docs/RUNTIME-V2.md` §4.5.
 */

import type {
  ChangeFileMap,
  DeltaKind,
  DeltaSpec,
  OpenSpecChange,
  ProposalDoc,
  SpecRequirement,
  SpecScenario,
  TaskItem,
  ValidationIssue,
  ValidationResult,
} from './types';

const DELTA_KINDS: DeltaKind[] = ['ADDED', 'MODIFIED', 'REMOVED'];

/**
 * Parse a flat file map (path → text, relative to a single change folder) into
 * a typed `OpenSpecChange`. Files we don't recognize are ignored — round-trip
 * support is a later concern; for now we only model what the Planner emits and
 * the Verifier reads.
 *
 * `id` is required because a file map doesn't carry the change directory name.
 */
export function parseChange(id: string, files: ChangeFileMap): OpenSpecChange {
  const proposalText = files['proposal.md'] ?? '';
  const tasksText = files['tasks.md'] ?? '';
  const designText = files['design.md'];

  const specs: DeltaSpec[] = [];
  for (const path of Object.keys(files)) {
    const match = /^specs\/(.+?)\/spec\.md$/.exec(path);
    if (!match) continue;
    const context = match[1] as string;
    specs.push(parseDeltaSpec(context, files[path] ?? ''));
  }
  // Stable order — keeps validation messages deterministic.
  specs.sort((a, b) => a.context.localeCompare(b.context));

  return {
    id,
    proposal: parseProposal(proposalText),
    tasks: parseTasks(tasksText),
    ...(designText !== undefined ? { design: splitLines(designText) } : {}),
    specs,
  };
}

/**
 * Validate a parsed change. Returns the full issue list; the caller decides
 * how to surface them (TUI cards, CI exit code, etc.). `ok` is true iff no
 * `error`-severity issue is present. Warnings are advisory.
 */
export function validateChange(change: OpenSpecChange): ValidationResult {
  const issues: ValidationIssue[] = [];

  // proposal.md — must have Why and What at minimum.
  if (change.proposal.why.length === 0) {
    issues.push({ file: 'proposal.md', severity: 'error', message: 'missing required `## Why` section' });
  }
  if (change.proposal.what.length === 0) {
    issues.push({ file: 'proposal.md', severity: 'error', message: 'missing required `## What Changes` section' });
  }
  // Why-Now is advisory — a warning, not an error.
  if (change.proposal.whyNow.length === 0) {
    issues.push({ file: 'proposal.md', severity: 'warning', message: 'no `## Why Now` section (recommended)' });
  }

  // tasks.md — at least one task, and we'd like meaningful task text.
  if (change.tasks.length === 0) {
    issues.push({ file: 'tasks.md', severity: 'error', message: 'tasks.md has no `- [ ]` tasks' });
  }
  for (let i = 0; i < change.tasks.length; i++) {
    const t = change.tasks[i] as TaskItem;
    if (!t.text.trim()) {
      issues.push({ file: 'tasks.md', severity: 'error', message: `task #${i + 1} has no description` });
    }
  }

  // specs/*/spec.md — each must use at least one delta section, and each
  // requirement must carry at least one scenario.
  for (const spec of change.specs) {
    const file = `specs/${spec.context}/spec.md`;
    const sections = Object.keys(spec.sections) as DeltaKind[];
    if (sections.length === 0) {
      issues.push({
        file,
        severity: 'error',
        message: 'no delta section (`## ADDED|MODIFIED|REMOVED Requirements`) found',
      });
      continue;
    }
    for (const kind of sections) {
      const reqs = spec.sections[kind] ?? [];
      if (reqs.length === 0) {
        issues.push({ file, severity: 'warning', message: `\`## ${kind} Requirements\` section is empty` });
        continue;
      }
      for (const req of reqs) {
        if (kind !== 'REMOVED' && req.scenarios.length === 0) {
          issues.push({
            file,
            severity: 'error',
            message: `requirement "${req.name}" has no \`#### Scenario:\` block`,
          });
        }
      }
    }
  }

  const ok = issues.every((i) => i.severity !== 'error');
  return { ok, issues };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsers — minimal markdown shape recognition. Keep them small and forgiving;
// we are not building a Pandoc replacement. The grammar is implicit in the
// emitter (`emit.ts`), so emit/parse round-trip cleanly for our own output.
// ─────────────────────────────────────────────────────────────────────────────

const splitLines = (text: string): string[] => text.replace(/\r\n/g, '\n').split('\n');

/**
 * Split text into top-level `## Section` chunks. Returns a map of normalized
 * section title → body lines (the `##` line itself is dropped). Headings deeper
 * than `##` stay with their parent section.
 */
function topSections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current = '';
  let buf: string[] = [];
  const flush = () => {
    if (current) out.set(current, buf);
  };
  for (const line of splitLines(text)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m && !line.startsWith('###')) {
      flush();
      current = (m[1] as string).trim().toLowerCase();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

function parseProposal(text: string): ProposalDoc {
  const sections = topSections(text);
  // Title aliases — accept the most common phrasings users actually type.
  const grab = (...names: string[]): string[] => {
    for (const n of names) {
      const found = sections.get(n);
      if (found) return found.filter((l) => l.trim().length > 0);
    }
    return [];
  };
  return {
    why: grab('why', 'why this change'),
    what: grab('what changes', 'what', 'what changes?'),
    whyNow: grab('why now', 'why-now', 'why now?'),
  };
}

function parseTasks(text: string): TaskItem[] {
  const items: TaskItem[] = [];
  for (const raw of splitLines(text)) {
    const m = /^\s*-\s*\[([ xX])\]\s*(.*)$/.exec(raw);
    if (!m) continue;
    items.push({ done: (m[1] as string).toLowerCase() === 'x', text: (m[2] as string).trim() });
  }
  return items;
}

function parseDeltaSpec(context: string, text: string): DeltaSpec {
  const sections: DeltaSpec['sections'] = {};
  let kind: DeltaKind | null = null;
  let currentReq: SpecRequirement | null = null;
  let currentScenario: SpecScenario | null = null;
  const pushReq = () => {
    if (kind && currentReq) {
      if (currentScenario) {
        currentReq.scenarios.push(currentScenario);
        currentScenario = null;
      }
      (sections[kind] ??= []).push(currentReq);
      currentReq = null;
    }
  };
  const pushScenario = () => {
    if (currentReq && currentScenario) {
      currentReq.scenarios.push(currentScenario);
      currentScenario = null;
    }
  };

  for (const line of splitLines(text)) {
    const top = /^##\s+(ADDED|MODIFIED|REMOVED)\s+Requirements\s*$/i.exec(line);
    if (top) {
      pushReq();
      kind = (top[1] as string).toUpperCase() as DeltaKind;
      if (!DELTA_KINDS.includes(kind)) kind = null;
      continue;
    }
    const reqMatch = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line);
    if (reqMatch && kind) {
      pushReq();
      currentReq = { name: (reqMatch[1] as string).trim(), body: [], scenarios: [] };
      continue;
    }
    const scenarioMatch = /^####\s+Scenario:\s*(.+?)\s*$/.exec(line);
    if (scenarioMatch && currentReq) {
      pushScenario();
      currentScenario = { name: (scenarioMatch[1] as string).trim(), body: [] };
      continue;
    }
    if (currentScenario) currentScenario.body.push(line);
    else if (currentReq) currentReq.body.push(line);
    // Lines outside any requirement section are silently ignored — typically
    // a file-level overview paragraph or blank padding.
  }
  pushReq();
  return { context, sections };
}
