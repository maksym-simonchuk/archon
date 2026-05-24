/**
 * In-process workflow registry (M33). Holds named WorkflowDefs and the
 * currently-suspended contexts so `/workflow run <id>` and
 * `/workflow resume <runId>` can drive them from the shell. The registry
 * itself is authority-free — step bodies still route every effect through
 * the Capability Broker (ADR-0015 invariant 2).
 */

import type { EventBus } from '../services/event-bus';
import { newRunId } from '../services/event-bus';
import {
  type RunResult,
  resumeWorkflow,
  runWorkflow,
  type WorkflowCtx,
  type WorkflowDef,
} from './workflow';

export interface RegisteredWorkflow {
  def: WorkflowDef<unknown, unknown>;
  /** One-line summary shown by `/workflow status`. */
  description: string;
}

export interface SuspendedRun {
  workflowId: string;
  runId: string;
  ctx: WorkflowCtx;
  reason: string;
  stepId: string;
  startedAt: number;
}

export class WorkflowRegistry {
  private readonly defs = new Map<string, RegisteredWorkflow>();
  private readonly suspended = new Map<string, SuspendedRun>();

  constructor(private readonly bus: EventBus) {}

  /** Register a workflow by id. Idempotent — re-registering replaces. */
  register<I, O>(def: WorkflowDef<I, O>, description: string): void {
    this.defs.set(def.id, { def: def as unknown as WorkflowDef<unknown, unknown>, description });
  }

  list(): Array<{ id: string; description: string }> {
    return [...this.defs.entries()].map(([id, w]) => ({ id, description: w.description }));
  }

  /** Start a workflow with the given input. Returns the run + result. */
  async run(workflowId: string, input: unknown): Promise<{ runId: string; result: RunResult<unknown> } | undefined> {
    const entry = this.defs.get(workflowId);
    if (!entry) return undefined;
    const runId = newRunId();
    const ctx: WorkflowCtx = { runId, bus: this.bus, outputs: {} };
    const result = await runWorkflow(entry.def, input, ctx);
    if (result.suspended) {
      this.suspended.set(runId, {
        workflowId,
        runId,
        ctx,
        reason: result.suspended.reason,
        stepId: result.suspended.stepId,
        startedAt: Date.now(),
      });
    }
    return { runId, result };
  }

  /** Resume a suspended run with the user's resolution. */
  async resume(runId: string, resolution: Record<string, unknown>): Promise<RunResult<unknown> | undefined> {
    const susp = this.suspended.get(runId);
    if (!susp) return undefined;
    const entry = this.defs.get(susp.workflowId);
    if (!entry) return undefined;
    const result = await resumeWorkflow(entry.def, susp.ctx, resolution);
    if (result.suspended) {
      // Workflow paused again — update the record.
      this.suspended.set(runId, {
        ...susp,
        reason: result.suspended.reason,
        stepId: result.suspended.stepId,
      });
    } else {
      this.suspended.delete(runId);
    }
    return result;
  }

  /** Currently-paused runs — for `/workflow status`. */
  suspendedRuns(): SuspendedRun[] {
    return [...this.suspended.values()];
  }
}
