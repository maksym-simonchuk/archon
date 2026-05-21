import type { StepResult } from '../core/types';
import type { MemoryStore } from '../memory/store';
import { notImplemented } from '../core/result';

/** Writes outcomes (success / failure / diffs) to episodic memory. */
export class Reflector {
  constructor(_memory: MemoryStore) {}

  async reflect(_results: StepResult[]): Promise<void> {
    return notImplemented('Reflector.reflect', 'M6');
  }
}
