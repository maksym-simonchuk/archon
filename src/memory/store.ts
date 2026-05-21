import type { MemoryRecord, MemoryTier } from '../core/types';
import { notImplemented } from '../core/result';

/**
 * Three-tier memory: episodic (task runs) -> semantic (decisions/ADRs/facts) ->
 * procedural (playbooks). Content-hash keys, recency/frequency/relevance decay,
 * pinned ADRs. See ADR-0008.
 */
export class MemoryStore {
  async write(_record: MemoryRecord): Promise<void> {
    return notImplemented('MemoryStore.write', 'M5');
  }

  async recall(_tier: MemoryTier, _key: string): Promise<MemoryRecord[]> {
    return notImplemented('MemoryStore.recall', 'M5');
  }
}
