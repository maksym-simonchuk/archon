/**
 * Patch store (M27/M32). Holds the most recent uncommitted PatchSet for the
 * UI to stage. Cognition publishes a PatchSet via `stage(...)`; the TUI
 * renders it; the user toggles hunks; `resolve()` returns the writes the
 * Capability Broker should perform.
 *
 * The store is a pure state container — it does NOT touch the filesystem.
 * Every write flows through the broker (ADR-0003); the store only decides
 * *what* should be written, not whether the broker may write it.
 */

import { newRunId, type EventBus } from '../../services/event-bus';
import {
  buildPatchSet,
  type PatchSet,
  type PendingEdit,
  resolvePatchSet,
  type ResolvedPatch,
  setHunkAccepted,
} from './patch-set';

export interface StagedSnapshot {
  /** Stable id for this staged patch — referenced by `patch.staged` event. */
  patchId: string;
  /** Run that generated this patch (correlates back to the turn). */
  runId: string;
  set: PatchSet;
  stagedAt: number;
}

export class PatchStore {
  private snapshot: StagedSnapshot | undefined;

  constructor(private readonly bus: EventBus) {}

  /**
   * Stage a new PatchSet — every hunk accepted by default. Replaces the
   * previous staged patch if any (the TUI shows only the latest queue).
   * Publishes `patch.staged` so subscribers can render.
   */
  stage(edits: PendingEdit[], runId: string): StagedSnapshot | undefined {
    const set = buildPatchSet(edits);
    // No hunks → nothing to stage; treat as a no-op so callers don't have to
    // pre-filter.
    const hunkCount = set.edits.reduce((n, e) => n + e.diff.hunks.length, 0);
    if (hunkCount === 0) return undefined;
    const snap: StagedSnapshot = {
      patchId: newPatchId(),
      runId,
      set,
      stagedAt: Date.now(),
    };
    this.snapshot = snap;
    this.bus.publish({
      kind: 'patch.staged',
      runId,
      at: snap.stagedAt,
      patchId: snap.patchId,
      files: set.edits.map((e) => e.path),
      hunks: hunkCount,
    });
    return snap;
  }

  /** Toggle one hunk; emits `patch.toggled`. Returns the new accepted state. */
  toggle(editIndex: number, hunkIndex: number): boolean | undefined {
    const cur = this.snapshot;
    if (!cur) return undefined;
    const row = cur.set.accepted[editIndex];
    if (!row || hunkIndex < 0 || hunkIndex >= row.length) return undefined;
    const next = !row[hunkIndex];
    this.snapshot = { ...cur, set: setHunkAccepted(cur.set, editIndex, hunkIndex, next) };
    this.bus.publish({
      kind: 'patch.toggled',
      runId: cur.runId,
      at: Date.now(),
      patchId: cur.patchId,
      editIndex,
      hunkIndex,
      accepted: next,
    });
    return next;
  }

  /**
   * Resolve and clear. Caller is responsible for writing the returned files
   * through the broker — the store does not perform I/O.
   */
  resolve(): { snapshot: StagedSnapshot; resolved: ResolvedPatch } | undefined {
    const cur = this.snapshot;
    if (!cur) return undefined;
    const resolved = resolvePatchSet(cur.set);
    this.snapshot = undefined;
    this.bus.publish({
      kind: 'patch.resolved',
      runId: cur.runId,
      at: Date.now(),
      patchId: cur.patchId,
      writes: Object.keys(resolved.writes).length,
      rejected: resolved.rejected.length,
      errors: resolved.errors.length,
    });
    return { snapshot: cur, resolved };
  }

  /** Discard without applying; publishes `patch.discarded`. */
  discard(): boolean {
    const cur = this.snapshot;
    if (!cur) return false;
    this.snapshot = undefined;
    this.bus.publish({
      kind: 'patch.discarded',
      runId: cur.runId,
      at: Date.now(),
      patchId: cur.patchId,
    });
    return true;
  }

  /** Read-only view; renderer-friendly. */
  current(): StagedSnapshot | undefined {
    return this.snapshot;
  }
}

/** Stable patch id factory. Crypto-random; correlates with bus events. */
export function newPatchId(): string {
  return `pat_${crypto.randomUUID()}`;
}

/** Re-exported convenience for shell helpers — they want to stage a working-tree edit. */
export function pendingEditFromText(path: string, before: string, after: string): PendingEdit {
  return { path, before, after };
}

/** Stable runId factory re-exported so callers don't reach across modules. */
export { newRunId };
