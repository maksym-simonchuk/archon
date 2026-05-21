import { join } from 'node:path';
import { err, ok, type Result } from '../core/result';
import type { Verdict } from '../core/types';
import type { CapabilityBroker } from './capability-broker';

export interface TransactionHandle {
  /** Absolute path of the isolated worktree where the task does its work. */
  worktree: string;
  /** Branch the worktree is checked out on (`archon/<taskId>`). */
  branch: string;
}

/**
 * Git-worktree transaction (ADR-0004): the task works in an isolated worktree on
 * its own branch, committing micro-steps. The Verifier's verdict decides the
 * outcome — merge the branch into the main tree on pass (`--no-ff`, preserving
 * the step series), discard the worktree on fail. Git is the undo log; the main
 * working tree is never touched until a verified merge, so a failed task leaves
 * it pristine. Every git command is gated by the CapabilityBroker.
 */
export class Transaction {
  private handle?: TransactionHandle;

  constructor(
    private readonly broker: CapabilityBroker,
    private readonly repoRoot: string,
    private readonly worktreeRoot: string,
  ) {}

  async begin(taskId: string): Promise<Result<TransactionHandle>> {
    if (this.handle) return err({ code: 'tx.active', message: 'transaction already begun' });
    const branch = `archon/${taskId}`;
    const worktree = join(this.worktreeRoot, taskId);
    const created = await this.broker.exec(['git', 'worktree', 'add', '-b', branch, worktree, 'HEAD'], {
      cwd: this.repoRoot,
      reason: `tx ${taskId}: create isolated worktree`,
    });
    if (!created.ok) return err(created.error);
    this.handle = { worktree, branch };
    return ok(this.handle);
  }

  /** Stage everything in the worktree and commit it as one reversible micro-step. */
  async commitStep(message: string): Promise<Result<void>> {
    if (!this.handle) return err({ code: 'tx.nostart', message: 'transaction not begun' });
    const staged = await this.broker.exec(['git', 'add', '-A'], {
      cwd: this.handle.worktree,
      reason: 'tx: stage step',
    });
    if (!staged.ok) return err(staged.error);
    const committed = await this.broker.exec(['git', 'commit', '-m', message], {
      cwd: this.handle.worktree,
      reason: 'tx: commit step',
    });
    if (!committed.ok) return err(committed.error);
    return ok(undefined);
  }

  /**
   * Merge the verified branch into the main tree on pass, or discard the
   * worktree on fail. The worktree is always removed; on failure the main tree
   * is left untouched. (The discarded branch is left for later GC — deleting it
   * needs a policy allowance the safe profile withholds.)
   */
  async finalize(verdict: Verdict): Promise<Result<'merged' | 'discarded'>> {
    if (!this.handle) return err({ code: 'tx.nostart', message: 'transaction not begun' });
    const { worktree, branch } = this.handle;

    if (!verdict.passed) {
      await this.removeWorktree(worktree);
      this.handle = undefined;
      return ok('discarded');
    }

    const merged = await this.broker.exec(['git', 'merge', '--no-ff', '-m', `merge ${branch}`, branch], {
      cwd: this.repoRoot,
      reason: 'tx: merge verified work',
    });
    await this.removeWorktree(worktree);
    this.handle = undefined;
    return merged.ok ? ok('merged') : err(merged.error);
  }

  private async removeWorktree(worktree: string): Promise<void> {
    await this.broker.exec(['git', 'worktree', 'remove', '--force', worktree], {
      cwd: this.repoRoot,
      reason: 'tx: remove worktree',
    });
  }
}
