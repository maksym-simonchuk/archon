/**
 * Hunk-granularity patch staging. Given a set of pending file edits (each a
 * unified diff), the user accepts/rejects per-hunk. Accepted hunks apply;
 * rejected hunks land as `pending-followup` so they don't get lost.
 */

import { applyUnified, diffStrings, type UnifiedDiff, selectHunks } from './unified';

export interface PendingEdit {
  path: string;
  /** Original file contents (empty string for a new file). */
  before: string;
  /** Proposed file contents. */
  after: string;
}

export interface StagedHunk {
  path: string;
  /** Index into the unified diff's hunks array. */
  hunkIndex: number;
  /** Pre-rendered hunk for display. */
  preview: string;
}

export interface PatchSet {
  /** All pending file changes, each fully diffed. */
  edits: Array<{ path: string; before: string; after: string; diff: UnifiedDiff }>;
  /** Per-edit hunk acceptance: same length as `edits[i].diff.hunks`. */
  accepted: boolean[][];
}

/** Build a fresh patch set with every hunk accepted by default. */
export function buildPatchSet(edits: PendingEdit[]): PatchSet {
  const out: PatchSet = { edits: [], accepted: [] };
  for (const e of edits) {
    const diff = diffStrings(e.before, e.after, `a/${e.path}`, `b/${e.path}`);
    out.edits.push({ path: e.path, before: e.before, after: e.after, diff });
    out.accepted.push(new Array(diff.hunks.length).fill(true));
  }
  return out;
}

/** Render every staged hunk in display order. */
export function listHunks(set: PatchSet): StagedHunk[] {
  const out: StagedHunk[] = [];
  for (let i = 0; i < set.edits.length; i++) {
    const e = set.edits[i];
    if (!e) continue;
    for (let j = 0; j < e.diff.hunks.length; j++) {
      const h = e.diff.hunks[j];
      if (!h) continue;
      out.push({
        path: e.path,
        hunkIndex: j,
        preview: [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n'),
      });
    }
  }
  return out;
}

/** Toggle a hunk's accepted state. */
export function setHunkAccepted(set: PatchSet, editIndex: number, hunkIndex: number, accepted: boolean): PatchSet {
  const next: boolean[][] = set.accepted.map((row, i) => (i === editIndex ? [...row] : row));
  const target = next[editIndex];
  if (target) target[hunkIndex] = accepted;
  return { ...set, accepted: next };
}

export interface ResolvedPatch {
  /** Files to write (path → final text). Includes only files with accepted changes. */
  writes: Record<string, string>;
  /** Hunks the user rejected — caller persists these as follow-ups. */
  rejected: StagedHunk[];
  /** Errors per file when accepted-only application fails. */
  errors: Array<{ path: string; reason: string }>;
}

/**
 * Resolve a patch set: apply only accepted hunks, return rejected hunks
 * separately. A file with all hunks rejected is omitted from `writes`.
 */
export function resolvePatchSet(set: PatchSet): ResolvedPatch {
  const writes: Record<string, string> = {};
  const rejected: StagedHunk[] = [];
  const errors: Array<{ path: string; reason: string }> = [];
  for (let i = 0; i < set.edits.length; i++) {
    const e = set.edits[i];
    const acc = set.accepted[i];
    if (!e || !acc) continue;
    const keep: number[] = [];
    for (let j = 0; j < e.diff.hunks.length; j++) {
      const h = e.diff.hunks[j];
      if (!h) continue;
      if (acc[j]) keep.push(j);
      else
        rejected.push({
          path: e.path,
          hunkIndex: j,
          preview: [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n'),
        });
    }
    if (keep.length === 0) continue;
    const filtered = selectHunks(e.diff, keep);
    const applied = applyUnified(e.before, filtered);
    if (!applied.ok) errors.push({ path: e.path, reason: applied.reason });
    else writes[e.path] = applied.text;
  }
  return { writes, rejected, errors };
}
