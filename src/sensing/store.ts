import { DatabaseSync } from 'node:sqlite';
import type { BoundaryModel } from './boundaries';
import type { ArchitecturalFingerprint, ParsedEdge, ParsedSymbol } from '../core/types';

/** An edge as queried back from the store (file provenance lives in `edges.file`). */
export interface StoredEdge {
  src: string;
  dst: string;
  kind: ParsedEdge['kind'];
}

/** One architecture-health reading at a point in repo history (M15 trend line). */
export interface HealthSnapshot {
  /** ISO timestamp the snapshot was recorded. */
  ts: string;
  /** The fingerprint `inputHash` this reading describes (its repo-state key). */
  inputHash: string;
  score: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * SQLite-backed persistence for the incremental index (ADR-0005): file content
 * hashes (Merkle leaves) plus the symbol graph (defines/imports/calls/tests).
 *
 * Backed by Node's built-in `node:sqlite` — no native dependency and no
 * prebuild/ABI coupling to the runtime, which is why it is used here instead of
 * better-sqlite3 (swapping back would stay local to this file). The API is
 * synchronous; the database is a single file (git-ignored runtime state under
 * `.archon/`), or `:memory:` in tests.
 */
export class IndexStore {
  private readonly db: DatabaseSync;

  constructor(location: string) {
    this.db = new DatabaseSync(location);
    if (location !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS symbols (
        name TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        kind TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS edges (
        src  TEXT NOT NULL,
        dst  TEXT NOT NULL,
        kind TEXT NOT NULL,
        file TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS arch_fingerprint (
        id      TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS module_intelligence (
        id      TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_edges (
        src TEXT NOT NULL,
        dst TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS health_history (
        id         INTEGER PRIMARY KEY,
        ts         TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        score      INTEGER NOT NULL,
        high       INTEGER NOT NULL,
        medium     INTEGER NOT NULL,
        low        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
      CREATE INDEX IF NOT EXISTS idx_edges_file ON edges(file);
      CREATE INDEX IF NOT EXISTS idx_file_edges_src ON file_edges(src);
      CREATE INDEX IF NOT EXISTS idx_file_edges_dst ON file_edges(dst);
    `);
  }

  /** The repository's structural fingerprint (M8), or undefined if never scanned. */
  getFingerprint(): ArchitecturalFingerprint | undefined {
    const row = this.db
      .prepare("SELECT payload FROM arch_fingerprint WHERE id = 'current'")
      .get() as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as ArchitecturalFingerprint) : undefined;
  }

  /** Persist the latest structural fingerprint (single-row; overwrites in place). */
  saveFingerprint(fp: ArchitecturalFingerprint): void {
    this.db
      .prepare(
        "INSERT INTO arch_fingerprint (id, payload) VALUES ('current', ?) " +
          'ON CONFLICT(id) DO UPDATE SET payload = excluded.payload',
      )
      .run(JSON.stringify(fp));
  }

  /** The persisted boundary/module intelligence layer (M10), or undefined if never derived. */
  loadModuleIntelligence(): BoundaryModel | undefined {
    const row = this.db
      .prepare("SELECT payload FROM module_intelligence WHERE id = 'current'")
      .get() as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as BoundaryModel) : undefined;
  }

  /** Persist the latest module intelligence (single-row; overwrites in place). */
  saveModuleIntelligence(model: BoundaryModel): void {
    this.db
      .prepare(
        "INSERT INTO module_intelligence (id, payload) VALUES ('current', ?) " +
          'ON CONFLICT(id) DO UPDATE SET payload = excluded.payload',
      )
      .run(JSON.stringify(model));
  }

  /** Content hash recorded for a file, or undefined if never indexed. */
  getFileHash(path: string): string | undefined {
    const row = this.db.prepare('SELECT hash FROM files WHERE path = ?').get(path) as
      | { hash: string }
      | undefined;
    return row?.hash;
  }

  upsertFileHash(path: string, hash: string): void {
    this.db
      .prepare('INSERT INTO files (path, hash) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash')
      .run(path, hash);
  }

  /**
   * Replace every symbol/edge originating from `file` in one transaction. This
   * is what keeps reindexing incremental: re-parsing a file overwrites only its
   * own slice of the graph, never the whole graph.
   */
  replaceFileGraph(file: string, symbols: ParsedSymbol[], edges: ParsedEdge[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM symbols WHERE file = ?').run(file);
      this.db.prepare('DELETE FROM edges WHERE file = ?').run(file);
      const insertSymbol = this.db.prepare('INSERT OR REPLACE INTO symbols (name, file, kind) VALUES (?, ?, ?)');
      for (const s of symbols) insertSymbol.run(s.name, file, s.kind);
      const insertEdge = this.db.prepare('INSERT INTO edges (src, dst, kind, file) VALUES (?, ?, ?, ?)');
      for (const e of edges) insertEdge.run(e.src, e.dst, e.kind, file);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Remove a file's hash and its entire graph slice (used when a file is deleted). */
  removeFile(path: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM files WHERE path = ?').run(path);
      this.db.prepare('DELETE FROM symbols WHERE file = ?').run(path);
      this.db.prepare('DELETE FROM edges WHERE file = ?').run(path);
      this.db.prepare('DELETE FROM file_edges WHERE src = ?').run(path);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Replace `src`'s outgoing cross-file import edges in one transaction (the
   * file-level companion to `replaceFileGraph`). `dsts` are repo-relative paths
   * `src` imports; reindexing a file overwrites only its own import slice.
   */
  replaceFileImports(src: string, dsts: string[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM file_edges WHERE src = ?').run(src);
      const insert = this.db.prepare('INSERT INTO file_edges (src, dst) VALUES (?, ?)');
      for (const dst of dsts) insert.run(src, dst);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Append an architecture-health snapshot (M15). Append-only time series: the
   * caller records one per indexed repo-state change (`init` gates on a changed
   * fingerprint), and the trend in `doctor` is read back from the sequence.
   */
  appendHealthSnapshot(snap: HealthSnapshot): void {
    this.db
      .prepare('INSERT INTO health_history (ts, input_hash, score, high, medium, low) VALUES (?, ?, ?, ?, ?, ?)')
      .run(snap.ts, snap.inputHash, snap.score, snap.high, snap.medium, snap.low);
  }

  /** Every health snapshot, oldest first — the temporal health trend (M15). */
  loadHealthHistory(): HealthSnapshot[] {
    const rows = this.db
      .prepare('SELECT ts, input_hash, score, high, medium, low FROM health_history ORDER BY id ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ts: r.ts as string,
      inputHash: r.input_hash as string,
      score: r.score as number,
      high: r.high as number,
      medium: r.medium as number,
      low: r.low as number,
    }));
  }

  /** Every file→file import edge — the module-topology substrate (M9). */
  loadFileEdges(): { src: string; dst: string }[] {
    const rows = this.db.prepare('SELECT src, dst FROM file_edges').all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({ src: r.src as string, dst: r.dst as string }));
  }

  /** Every edge in the graph (caller filters by kind). */
  loadEdges(): StoredEdge[] {
    const rows = this.db.prepare('SELECT src, dst, kind FROM edges').all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({ src: r.src as string, dst: r.dst as string, kind: r.kind as ParsedEdge['kind'] }));
  }

  /** Every symbol node with its file + kind (the repo-map's vertices). */
  allSymbols(): { name: string; file: string; kind: string }[] {
    const rows = this.db.prepare('SELECT name, file, kind FROM symbols').all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({ name: r.name as string, file: r.file as string, kind: r.kind as string }));
  }

  /** All file content hashes, ordered by path — a stable repo-state fingerprint. */
  allFileHashes(): { path: string; hash: string }[] {
    const rows = this.db
      .prepare('SELECT path, hash FROM files ORDER BY path')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({ path: r.path as string, hash: r.hash as string }));
  }

  /** Distinct files that define any of the given symbols. */
  filesForSymbols(names: string[]): string[] {
    if (names.length === 0) return [];
    const placeholders = names.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT DISTINCT file FROM symbols WHERE name IN (${placeholders})`)
      .all(...names) as { file: string }[];
    return rows.map((r) => r.file);
  }

  close(): void {
    this.db.close();
  }
}
