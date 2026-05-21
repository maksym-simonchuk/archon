import type { Diff, PlanStep, StepResult } from '../core/types';
import type { CapabilityBroker } from '../effecting/capability-broker';
import type { StepAction } from './types';

const fail = (stepId: string, check: string, output: string): StepResult => ({
  stepId,
  verdict: { passed: false, checks: [{ name: check, passed: false, output }] },
});

/**
 * Executes one plan step. Every side effect goes through the broker — the
 * Executor holds no ambient authority and is constructed with a broker rooted at
 * the task's worktree, so writes land in isolation (ADR-0004). A denied or failed
 * effect becomes a failed `StepResult` rather than a throw, so the loop can
 * finalize the transaction and discard cleanly.
 */
export class Executor {
  constructor(
    private readonly broker: CapabilityBroker,
    private readonly taskId: string,
  ) {}

  async run(step: PlanStep, action: StepAction): Promise<StepResult> {
    if (action.kind !== 'write') return fail(step.id, 'apply', `unsupported action kind: ${action.kind}`);

    const written = await this.broker.fsWrite(action.target, action.content, {
      blastRadius: step.capability.blastRadius,
      reason: step.intent,
      taskId: this.taskId,
      inWorktree: true,
    });
    if (!written.ok) return fail(step.id, 'apply', written.error.message);

    const diff: Diff = {
      files: [action.target],
      added: action.content.split('\n').filter((line) => line.length > 0).length,
      removed: 0,
      patch: action.content,
    };
    return { stepId: step.id, diff, verdict: { passed: true, checks: [{ name: 'apply', passed: true }] } };
  }
}
