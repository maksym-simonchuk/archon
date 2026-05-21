import { DatabaseSync } from 'node:sqlite';
import type { MemoryRecord, MemoryTier } from '../core/types';

const TIER_ORDER: MemoryTier[] = ['episodic', 'semantic', 'procedural'];

const nextTier = (t: MemoryTier): MemoryTier | undefined => {
  const i = TIER_ORDER.indexOf(t);
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : undefined;
};

const toRecord = (r: Record<string, unknown>): MemoryRecord => ({
  id: r.id as string,
  tier: r.tier as MemoryTier,
  key: r.key as string,
  content: r.content as string,
  createdAt: r.created_at as string,
  confirmed: (r.confirmed as number) === 1,
});

export interface MemoryWriteOptions {
  /** Pinned records (e.g. ADRs) sort first on recall and are never evicted. */
  pinned?: boolean;
}

/**
 * Three-tier memory: episodic (task runs) → semantic (decisions/ADRs/facts) →
 * procedural (playbooks). Content-hash / entity keys, access-decay eviction,
 * pinned ADRs. Backed by `node:sqlite` (same rationale as the index store: no
 * native dependency). See ADR-0008.
 */
export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(location: string) {
    this.db = new DatabaseSync(location);
    if (location !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id          TEXT PRIMARY KEY,
        tier        TEXT NOT NULL,
        key         TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        confirmed   INTEGER NOT NULL DEFAULT 0,
        pinned      INTEGER NOT NULL DEFAULT 0,
        freq        INTEGER NOT NULL DEFAULT 0,
        success     INTEGER NOT NULL DEFAULT 0,
        last_access TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_tier_key ON memory(tier, key);
    `);
  }

  /** Insert or replace a record (content-hash / entity key supplied by caller). */
  write(record: MemoryRecord, opts: MemoryWriteOptions = {}): void {
    this.db
      .prepare(
        `INSERT INTO memory (id, tier, key, content, created_at, confirmed, pinned, last_access)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           tier = excluded.tier, key = excluded.key, content = excluded.content,
           confirmed = excluded.confirmed, pinned = excluded.pinned`,
      )
      .run(
        record.id,
        record.tier,
        record.key,
        record.content,
        record.createdAt,
        record.confirmed ? 1 : 0,
        opts.pinned ? 1 : 0,
        record.createdAt,
      );
  }

  /**
   * Recall records for a tier+key, **pinned (ADRs) first**, then by access decay
   * (frequency, then recency). Recall counts as an access, bumping frequency.
   */
  recall(tier: MemoryTier, key: string): MemoryRecord[] {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE memory SET freq = freq + 1, last_access = ? WHERE tier = ? AND key = ?')
      .run(now, tier, key);
    const rows = this.db
      .prepare(
        `SELECT id, tier, key, content, created_at, confirmed, pinned FROM memory
         WHERE tier = ? AND key = ?
         ORDER BY pinned DESC, freq DESC, last_access DESC`,
      )
      .all(tier, key) as Array<Record<string, unknown>>;
    return rows.map(toRecord);
  }

  /** One record by id (does not count as an access). */
  get(id: string): MemoryRecord | undefined {
    const row = this.db
      .prepare('SELECT id, tier, key, content, created_at, confirmed, pinned FROM memory WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Mark that a record contributed to a successful task run. */
  recordSuccess(id: string): void {
    this.db.prepare('UPDATE memory SET success = success + 1 WHERE id = ?').run(id);
  }

  /** Records that meet the promotion bar (freq + success) and aren't confirmed. */
  promotionCandidates(minFreq: number, minSuccess: number): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, tier, key, content, created_at, confirmed, pinned FROM memory
         WHERE confirmed = 0 AND tier != 'procedural' AND freq >= ? AND success >= ?`,
      )
      .all(minFreq, minSuccess) as Array<Record<string, unknown>>;
    return rows.map(toRecord);
  }

  /** Promote one tier up and mark confirmed. The human-gated mutation. */
  promote(id: string): MemoryTier | undefined {
    const row = this.db.prepare('SELECT tier FROM memory WHERE id = ?').get(id) as
      | { tier: MemoryTier }
      | undefined;
    if (!row) return undefined;
    const next = nextTier(row.tier);
    if (!next) return undefined;
    this.db.prepare('UPDATE memory SET tier = ?, confirmed = 1 WHERE id = ?').run(next, id);
    return next;
  }

  /**
   * Evict the lowest-value unpinned records in a tier beyond `keep`, by access
   * decay (frequency, then recency). Pinned records (ADRs) are never evicted.
   * Returns the number removed.
   */
  evict(tier: MemoryTier, keep: number): number {
    const rows = this.db
      .prepare('SELECT id FROM memory WHERE tier = ? AND pinned = 0 ORDER BY freq DESC, last_access DESC')
      .all(tier) as Array<{ id: string }>;
    const doomed = rows.slice(keep);
    const del = this.db.prepare('DELETE FROM memory WHERE id = ?');
    for (const r of doomed) del.run(r.id);
    return doomed.length;
  }

  close(): void {
    this.db.close();
  }
}
