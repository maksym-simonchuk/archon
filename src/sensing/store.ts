import { DatabaseSync } from 'node:sqlite';
import type { ParsedEdge, ParsedSymbol } from '../core/types';

/** An edge as queried back from the store (file provenance lives in `edges.file`). */
export interface StoredEdge {
  src: string;
  dst: string;
  kind: ParsedEdge['kind'];
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
      CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
      CREATE INDEX IF NOT EXISTS idx_edges_file ON edges(file);
    `);
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
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
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
