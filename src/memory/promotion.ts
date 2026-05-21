import type { MemoryRecord, MemoryTier } from '../core/types';
import type { MemoryStore } from './store';

export interface PromotionThresholds {
  minFreq: number;
  minSuccess: number;
}

const DEFAULT_THRESHOLDS: PromotionThresholds = { minFreq: 3, minSuccess: 2 };

/**
 * Promotes episodic → semantic → procedural ONLY on frequency + success AND an
 * explicit confirmation. `propose()` lists candidates but changes nothing;
 * `confirm()` is the sole path that actually moves a record up a tier — this is
 * what stops a bad playbook from quietly poisoning future runs. See ADR-0008.
 */
export class PromotionEngine {
  constructor(
    private readonly store: MemoryStore,
    private readonly thresholds: PromotionThresholds = DEFAULT_THRESHOLDS,
  ) {}

  /** Candidates that meet the bar, pending confirmation. Promotes nothing. */
  async propose(): Promise<MemoryRecord[]> {
    return this.store.promotionCandidates(this.thresholds.minFreq, this.thresholds.minSuccess);
  }

  /** The gate: confirm a candidate, moving it one tier up. Returns the new tier. */
  async confirm(id: string): Promise<MemoryTier | undefined> {
    return this.store.promote(id);
  }
}
