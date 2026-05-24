import { DatabaseSync } from 'node:sqlite';
import type { JournalEntry } from '../core/types';
import type { ArchonEvent } from './event-bus';

const toEntry = (r: Record<string, unknown>): JournalEntry => ({
  seq: r.seq as number,
  taskId: r.task_id as string,
  ts: r.ts as string,
  kind: r.kind as JournalEntry['kind'],
  payload: JSON.parse(r.payload as string) as unknown,
});

/**
 * One row of the bus journal — a single ArchonEvent serialized for replay.
 * `seq` orders events globally; `runId` clusters them per-turn so the replay
 * command can reconstruct one stream without scanning the whole table.
 */
export interface BusJournalEntry {
  seq: number;
  runId: string;
  /** The event's wall-clock `at` (epoch ms). */
  at: number;
  /** Discriminator (e.g. 'token.delta'). */
  kind: ArchonEvent['kind'];
  event: ArchonEvent;
}

const toBusEntry = (r: Record<string, unknown>): BusJournalEntry => ({
  seq: r.seq as number,
  runId: r.run_id as string,
  at: r.at as number,
  kind: r.kind as ArchonEvent['kind'],
  event: JSON.parse(r.event as string) as ArchonEvent,
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

      CREATE TABLE IF NOT EXISTS bus_journal (
        seq    INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        at     INTEGER NOT NULL,
        kind   TEXT NOT NULL,
        event  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bus_run ON bus_journal(run_id);
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

  /**
   * Persist a single ArchonEvent. The whole event payload is stored as JSON so
   * replay reconstructs the exact wire shape — no schema lossiness. Safe to
   * call from a bus subscriber; sqlite writes are synchronous from JS's POV.
   */
  appendBusEvent(event: ArchonEvent): BusJournalEntry {
    const res = this.db
      .prepare('INSERT INTO bus_journal (run_id, at, kind, event) VALUES (?, ?, ?, ?)')
      .run(event.runId, event.at, event.kind, JSON.stringify(event));
    return { seq: Number(res.lastInsertRowid), runId: event.runId, at: event.at, kind: event.kind, event };
  }

  /** Every bus event for a run, in `at`/seq order — the replay stream. */
  replayBus(runId: string): BusJournalEntry[] {
    const rows = this.db
      .prepare('SELECT seq, run_id, at, kind, event FROM bus_journal WHERE run_id = ? ORDER BY seq')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map(toBusEntry);
  }

  /** Distinct runIds in the bus journal, newest first — for `/replay` listing. */
  recentRunIds(limit = 20): Array<{ runId: string; lastAt: number; events: number }> {
    const rows = this.db
      .prepare(
        'SELECT run_id, MAX(at) AS last_at, COUNT(*) AS n FROM bus_journal GROUP BY run_id ORDER BY last_at DESC LIMIT ?',
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      runId: r.run_id as string,
      lastAt: r.last_at as number,
      events: r.n as number,
    }));
  }

  close(): void {
    this.db.close();
  }
}
