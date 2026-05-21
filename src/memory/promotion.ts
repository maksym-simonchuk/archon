import type { MemoryRecord } from '../core/types';
import { notImplemented } from '../core/result';

/**
 * Promotes episodic -> semantic -> procedural ONLY on frequency + success AND an
 * explicit human/heuristic confirmation. Never silent — this is what prevents a
 * bad playbook from quietly poisoning future runs. See ADR-0008.
 */
export class PromotionEngine {
  /** Candidate records that meet the frequency/success bar, pending confirm. */
  async propose(): Promise<MemoryRecord[]> {
    return notImplemented('PromotionEngine.propose', 'M5');
  }

  async confirm(_id: string): Promise<void> {
    return notImplemented('PromotionEngine.confirm', 'M5');
  }
}
