import type { ComputeCore } from '../core/compute';
import { notImplemented } from '../core/result';

/**
 * Incremental indexer. Reindexes ONLY the paths reported by `git diff` / the
 * file watcher, keyed by content hash (a Merkle DAG). Never full-rescans.
 * Hashing runs in the Rust/WASM compute core (ADR-0011); this class owns the
 * git/fs I/O (via the Capability Broker) and feeds the core bytes. See ADR-0005.
 */
export class Indexer {
  constructor(_core: ComputeCore) {}

  /** Paths changed since the last indexed commit/hash. */
  async dirtyPaths(): Promise<string[]> {
    return notImplemented('Indexer.dirtyPaths', 'M1');
  }

  async reindex(_paths: string[]): Promise<void> {
    return notImplemented('Indexer.reindex', 'M1');
  }
}
