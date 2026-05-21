import type { Diff, Verdict } from '../core/types';
import { notImplemented } from '../core/result';

/**
 * Git-worktree transaction: stage micro-steps as commits in an isolated
 * worktree, run the Verifier, merge on green / discard on failure. Git is the
 * undo log — no bespoke rollback engine. See ADR-0004.
 */
export class Transaction {
  async begin(_taskId: string): Promise<void> {
    return notImplemented('Transaction.begin', 'M4');
  }

  async commitStep(_diff: Diff): Promise<void> {
    return notImplemented('Transaction.commitStep', 'M4');
  }

  async finalize(_verdict: Verdict): Promise<'merged' | 'discarded'> {
    return notImplemented('Transaction.finalize', 'M4');
  }
}
