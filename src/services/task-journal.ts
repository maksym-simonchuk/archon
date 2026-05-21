import { DatabaseSync } from 'node:sqlite';
import type { JournalEntry } from '../core/types';

const toEntry = (r: Record<string, unknown>): JournalEntry => ({
  seq: r.seq as number,
  taskId: r.task_id as string,
  ts: r.ts as string,
  kind: r.kind as JournalEntry['kind'],
  payload: JSON.parse(r.payload as string) as unknown,
});

/**
 * Append-only, durable log of every task event (plan / step / decision / diff /
 * verdict / cost) — the source of truth for crash-resume and audit. Backed by
 * `node:sqlite` (same rationale as the index/memory stores: no native dep);
 * `:memory:` in tests. `seq` is assigned here and increases monotonically.
 * Single-process today; a multi-process deployment reads the identical table
 * with no redesign. See ARCHITECTURE.md.
 */
export class TaskJournal {
  private readonly db: DatabaseSync;

  constructor(location: string) {
    this.db = new DatabaseSync(location);
    if (location !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal (
        seq     INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        ts      TEXT NOT NULL,
        kind    TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_journal_task ON journal(task_id);
    `);
  }

  /** Append one event; `seq` is assigned by the store. Returns the stored entry. */
  append(entry: Omit<JournalEntry, 'seq'>): JournalEntry {
    const res = this.db
      .prepare('INSERT INTO journal (task_id, ts, kind, payload) VALUES (?, ?, ?, ?)')
      .run(entry.taskId, entry.ts, entry.kind, JSON.stringify(entry.payload ?? null));
    return { ...entry, seq: Number(res.lastInsertRowid) };
  }

  /** Every entry for a task, in append order — the crash-resume replay stream. */
  async replay(taskId: string): Promise<JournalEntry[]> {
    const rows = this.db
      .prepare('SELECT seq, task_id, ts, kind, payload FROM journal WHERE task_id = ? ORDER BY seq')
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map(toEntry);
  }

  /** The most recent `limit` entries across all tasks, newest first — for status. */
  recent(limit = 20): JournalEntry[] {
    const rows = this.db
      .prepare('SELECT seq, task_id, ts, kind, payload FROM journal ORDER BY seq DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(toEntry);
  }

  close(): void {
    this.db.close();
  }
}
