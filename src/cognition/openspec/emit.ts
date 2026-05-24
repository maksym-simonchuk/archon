/**
 * Emit an OpenSpec change folder as a flat path → contents map. Pure; the
 * caller writes the files through the Capability Broker (ADR-0003). The
 * emitter never imports `fs`, `path`, or `child_process` — keeping us aligned
 * with the v2 safety invariant "every side effect is a broker call"
 * (ADR-0015).
 *
 * The format is the inverse of `parseChange` in `validate.ts`: emit + parse
 * round-trip is a tested invariant.
 */

import type { ChangeFileMap, OpenSpecChange, DeltaSpec } from './types';

/** Convert an `OpenSpecChange` into a relative-path → file-text map. */
export function emitChange(change: OpenSpecChange): ChangeFileMap {
  const files: ChangeFileMap = {
    'proposal.md': renderProposal(change),
    'tasks.md': renderTasks(change),
  };
  if (change.design && change.design.length > 0) {
    files['design.md'] = renderDesign(change);
  }
  for (const spec of change.specs) {
    files[`specs/${spec.context}/spec.md`] = renderDeltaSpec(spec);
  }
  return files;
}

/**
 * Compose the absolute (workspace-relative) paths for a change at
 * `openspec/changes/<id>/...`. Useful for callers that take a `ChangeFileMap`
 * and need to forward writes to the broker keyed by repo path.
 */
export function changePaths(change: OpenSpecChange, files: ChangeFileMap): ChangeFileMap {
  const out: ChangeFileMap = {};
  for (const [rel, text] of Object.entries(files)) {
    out[`openspec/changes/${change.id}/${rel}`] = text;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderProposal(c: OpenSpecChange): string {
  const parts: string[] = [`# ${humanize(c.id)}`, ''];
  parts.push('## Why', '', ...nonEmpty(c.proposal.why), '');
  parts.push('## What Changes', '', ...nonEmpty(c.proposal.what), '');
  if (c.proposal.whyNow.length > 0) {
    parts.push('## Why Now', '', ...nonEmpty(c.proposal.whyNow), '');
  }
  return joinWithTrailingNewline(parts);
}

function renderTasks(c: OpenSpecChange): string {
  const lines: string[] = ['# Tasks', ''];
  for (const t of c.tasks) {
    lines.push(`- [${t.done ? 'x' : ' '}] ${t.text}`);
  }
  lines.push('');
  return joinWithTrailingNewline(lines);
}

function renderDesign(c: OpenSpecChange): string {
  const lines = ['# Design', '', ...nonEmpty(c.design ?? []), ''];
  return joinWithTrailingNewline(lines);
}

function renderDeltaSpec(spec: DeltaSpec): string {
  const out: string[] = [`# ${humanize(spec.context)} — Delta Spec`, ''];
  for (const kind of ['ADDED', 'MODIFIED', 'REMOVED'] as const) {
    const reqs = spec.sections[kind];
    if (!reqs || reqs.length === 0) continue;
    out.push(`## ${kind} Requirements`, '');
    for (const req of reqs) {
      out.push(`### Requirement: ${req.name}`, '');
      out.push(...nonEmpty(req.body));
      if (req.body.length > 0) out.push('');
      for (const sc of req.scenarios) {
        out.push(`#### Scenario: ${sc.name}`, '');
        out.push(...nonEmpty(sc.body));
        if (sc.body.length > 0) out.push('');
      }
    }
  }
  return joinWithTrailingNewline(out);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const nonEmpty = (lines: string[]): string[] => {
  // Trim trailing blanks but keep internal structure — keeps diffs minimal.
  const out = [...lines];
  while (out.length > 0 && (out[out.length - 1] as string).trim() === '') out.pop();
  return out;
};

const joinWithTrailingNewline = (lines: string[]): string => `${lines.join('\n')}\n`;

const humanize = (slug: string): string =>
  slug
    .split(/[-_/]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
