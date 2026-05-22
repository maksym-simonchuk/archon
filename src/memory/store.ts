import { DatabaseSync } from 'node:sqlite';
import type { MemoryRecord, MemoryTier } from '../core/types';
import { packVector, unpackVector } from './vector-index';

/** A recalled record paired with its persisted embedding (M24 semantic recall). */
export interface VectorRecord {
  content: string;
  vector: Float32Array;
}

/** Computes an embedding for a record's content. Injected so the store stays
 *  decoupled from the embedding algorithm (and tests can omit it entirely). */
export type Embedder = (text: string) => Float32Array;

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

  /** When provided, each `write` persists an embedding of the record's content,
   *  enabling persisted-vector semantic recall (`recallVectors`). */
  constructor(
    location: string,
    private readonly embed?: Embedder,
  ) {
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
      CREATE TABLE IF NOT EXISTS memory_vectors (
        id  TEXT PRIMARY KEY,
        vec BLOB NOT NULL
      );
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
    // Persist the content embedding for semantic recall. Re-embedding on every
    // write keeps the vector in lock-step with the (possibly edited) content.
    if (this.embed !== undefined) {
      this.db
        .prepare('INSERT INTO memory_vectors (id, vec) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET vec = excluded.vec')
        .run(record.id, packVector(this.embed(record.content)));
    }
  }

  /**
   * Recall records for a tier+key paired with their persisted embeddings — the
   * substrate for vector semantic recall (M24). Like {@link recall} it counts as
   * an access (bumps frequency). Records written before an embedder was attached
   * have no vector and are omitted (they remain reachable via plain `recall`).
   */
  recallVectors(tier: MemoryTier, key: string): VectorRecord[] {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE memory SET freq = freq + 1, last_access = ? WHERE tier = ? AND key = ?')
      .run(now, tier, key);
    const rows = this.db
      .prepare(
        `SELECT m.content AS content, v.vec AS vec FROM memory m
         JOIN memory_vectors v ON v.id = m.id
         WHERE m.tier = ? AND m.key = ?
         ORDER BY m.pinned DESC, m.freq DESC, m.last_access DESC`,
      )
      .all(tier, key) as Array<{ content: string; vec: Uint8Array }>;
    return rows.map((r) => ({ content: r.content, vector: unpackVector(r.vec) }));
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

  /**
   * Every record, optionally narrowed to one tier — pinned (ADRs) first, then by
   * access decay (frequency, then recency). Read-only inspection for `archon
   * memory list`; unlike `recall` it does NOT count as an access.
   */
  list(tier?: MemoryTier): MemoryRecord[] {
    const cols = 'id, tier, key, content, created_at, confirmed, pinned';
    const order = 'ORDER BY pinned DESC, freq DESC, last_access DESC';
    const rows = (
      tier === undefined
        ? this.db.prepare(`SELECT ${cols} FROM memory ${order}`).all()
        : this.db.prepare(`SELECT ${cols} FROM memory WHERE tier = ? ${order}`).all(tier)
    ) as Array<Record<string, unknown>>;
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
    const delVec = this.db.prepare('DELETE FROM memory_vectors WHERE id = ?');
    for (const r of doomed) {
      del.run(r.id);
      delVec.run(r.id); // keep the vector index in step with eviction
    }
    return doomed.length;
  }

  close(): void {
    this.db.close();
  }
}
