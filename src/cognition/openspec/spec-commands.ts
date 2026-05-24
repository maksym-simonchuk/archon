/**
 * `/spec` command surface (M29-finish). Pure logic — no I/O. Callers provide
 * a `SpecStore` to read/write change folders through the broker.
 *
 * Subcommands:
 *   status                — list active changes + archived count
 *   diff <id>             — render the change's specs as a delta summary
 *   validate <id>         — run the validator; return ok + issue list
 *   archive <id>          — move active change → archive (caller writes)
 */

import type { ChangeFileMap, OpenSpecChange, ValidationResult } from './types';
import { parseChange, validateChange } from './validate';

export interface SpecStore {
  listActive(): Promise<string[]>;
  listArchived(): Promise<string[]>;
  readChange(id: string): Promise<ChangeFileMap | null>;
  writeChange(id: string, files: ChangeFileMap): Promise<void>;
  archiveChange(id: string): Promise<void>;
}

export interface SpecStatus {
  active: string[];
  archived: string[];
}

export interface SpecDiff {
  id: string;
  byContext: Array<{ context: string; added: number; modified: number; removed: number }>;
  totalTasks: number;
  completedTasks: number;
}

export async function specStatus(store: SpecStore): Promise<SpecStatus> {
  const [active, archived] = await Promise.all([store.listActive(), store.listArchived()]);
  return { active: active.sort(), archived: archived.sort() };
}

export async function specDiff(store: SpecStore, id: string): Promise<SpecDiff | null> {
  const files = await store.readChange(id);
  if (!files) return null;
  const change = parseChange(id, files);
  const byContext = change.specs.map((s) => ({
    context: s.context,
    added: s.sections.ADDED?.length ?? 0,
    modified: s.sections.MODIFIED?.length ?? 0,
    removed: s.sections.REMOVED?.length ?? 0,
  }));
  return {
    id,
    byContext,
    totalTasks: change.tasks.length,
    completedTasks: change.tasks.filter((t) => t.done).length,
  };
}

export async function specValidate(store: SpecStore, id: string): Promise<ValidationResult | null> {
  const files = await store.readChange(id);
  if (!files) return null;
  return validateChange(parseChange(id, files));
}

export async function specArchive(store: SpecStore, id: string): Promise<{ ok: boolean; reason?: string }> {
  const validation = await specValidate(store, id);
  if (!validation) return { ok: false, reason: `change "${id}" not found` };
  if (!validation.ok) return { ok: false, reason: `validation failed: ${validation.issues.find((i) => i.severity === 'error')?.message ?? 'unknown'}` };
  await store.archiveChange(id);
  return { ok: true };
}

/** In-memory spec store — useful for tests + the substrate of the FS-backed impl. */
export class MemorySpecStore implements SpecStore {
  private active = new Map<string, ChangeFileMap>();
  private archived = new Set<string>();
  private archivedFiles = new Map<string, ChangeFileMap>();

  async listActive(): Promise<string[]> {
    return [...this.active.keys()];
  }
  async listArchived(): Promise<string[]> {
    return [...this.archived];
  }
  async readChange(id: string): Promise<ChangeFileMap | null> {
    return this.active.get(id) ?? this.archivedFiles.get(id) ?? null;
  }
  async writeChange(id: string, files: ChangeFileMap): Promise<void> {
    this.active.set(id, files);
  }
  async archiveChange(id: string): Promise<void> {
    const f = this.active.get(id);
    if (!f) return;
    this.active.delete(id);
    this.archived.add(id);
    this.archivedFiles.set(id, f);
  }

  /** For test seeding without going through `writeChange`. */
  seed(change: OpenSpecChange, files: ChangeFileMap): void {
    this.active.set(change.id, files);
  }
}
