/**
 * Workflow engine (M33). Pure-TS DAG runtime, Mastra-shaped: `createStep`,
 * `then`, `parallel`, `branch`, `dowhile`, `suspend` / `resume`. No dep on
 * `@mastra/core` yet — we keep this in our own boundary so step bodies must
 * use the broker explicitly (ADR-0014, ADR-0015).
 *
 * Each step is a pure function over its input plus an injected `WorkflowCtx`.
 * The runtime emits `tool.start` / `tool.result` events for each step so the
 * v2 UI surfaces are coherent with cognition steps.
 */

import type { EventBus } from '../services/event-bus';

export interface WorkflowCtx {
  runId: string;
  bus?: EventBus;
  /** Per-run scratch space — steps may read prior step outputs by id. */
  outputs: Record<string, unknown>;
  /** Set by `suspend` — the runtime pauses until `resume` is called. */
  suspended?: { stepId: string; reason: string };
}

export type StepOutcome<O> = { ok: true; value: O } | { ok: false; error: string };

export interface Step<I, O> {
  id: string;
  /** Pure step body. Throw to fail; return `{ok:false}` for an expected reject. */
  run(input: I, ctx: WorkflowCtx): Promise<StepOutcome<O>>;
}

export const createStep = <I, O>(id: string, run: (input: I, ctx: WorkflowCtx) => Promise<StepOutcome<O>>): Step<I, O> => ({ id, run });

/** Sentinel — thrown from a step to suspend the workflow. */
export class WorkflowSuspended extends Error {
  constructor(public readonly stepId: string, public readonly reason: string) {
    super(`workflow suspended at ${stepId}: ${reason}`);
  }
}

export interface WorkflowDef<I, O> {
  id: string;
  nodes: Array<
    | { kind: 'step'; step: Step<unknown, unknown> }
    | { kind: 'parallel'; steps: Array<Step<unknown, unknown>> }
    | { kind: 'branch'; predicate: (state: Record<string, unknown>) => string; arms: Record<string, Array<Step<unknown, unknown>>> }
    | { kind: 'loop'; condition: (state: Record<string, unknown>) => boolean; body: Array<Step<unknown, unknown>>; maxIters: number }
  >;
  /** Cast the final outputs map to the declared output. */
  finalize: (outputs: Record<string, unknown>) => O;
  /** Cast the user input to the first step's input. */
  start: (input: I) => unknown;
}

export class WorkflowBuilder<I, S> {
  private readonly nodes: WorkflowDef<I, unknown>['nodes'] = [];
  constructor(private readonly id: string, private readonly starter: (input: I) => unknown) {}

  then<O>(step: Step<S, O>): WorkflowBuilder<I, O> {
    this.nodes.push({ kind: 'step', step: step as Step<unknown, unknown> });
    return this as unknown as WorkflowBuilder<I, O>;
  }

  parallel<O>(...steps: Array<Step<S, O>>): WorkflowBuilder<I, Record<string, O>> {
    this.nodes.push({ kind: 'parallel', steps: steps as Array<Step<unknown, unknown>> });
    return this as unknown as WorkflowBuilder<I, Record<string, O>>;
  }

  branch(predicate: (state: Record<string, unknown>) => string, arms: Record<string, Array<Step<unknown, unknown>>>): WorkflowBuilder<I, S> {
    this.nodes.push({ kind: 'branch', predicate, arms });
    return this;
  }

  dowhile(condition: (state: Record<string, unknown>) => boolean, body: Array<Step<unknown, unknown>>, maxIters = 16): WorkflowBuilder<I, S> {
    this.nodes.push({ kind: 'loop', condition, body, maxIters });
    return this;
  }

  build<O>(finalize: (outputs: Record<string, unknown>) => O): WorkflowDef<I, O> {
    return { id: this.id, nodes: this.nodes, finalize, start: this.starter };
  }
}

export const createWorkflow = <I, S = I>(id: string, starter: (input: I) => unknown = (i) => i as unknown): WorkflowBuilder<I, S> =>
  new WorkflowBuilder<I, S>(id, starter);

export interface RunResult<O> {
  ok: boolean;
  output?: O;
  failedAt?: string;
  error?: string;
  outputs: Record<string, unknown>;
  /** When set, the run paused; call `resume` with the resolution. */
  suspended?: { stepId: string; reason: string };
}

/** Execute a workflow to completion (or first suspension / first failure). */
export async function runWorkflow<I, O>(def: WorkflowDef<I, O>, input: I, ctx: WorkflowCtx): Promise<RunResult<O>> {
  let cursor = def.start(input);
  for (const node of def.nodes) {
    if (node.kind === 'step') {
      const r = await execStep(node.step, cursor, ctx);
      if ('suspended' in r) return { ok: false, suspended: r.suspended, outputs: ctx.outputs };
      if (!r.ok) return { ok: false, failedAt: node.step.id, error: r.error, outputs: ctx.outputs };
      cursor = r.value;
    } else if (node.kind === 'parallel') {
      const out: Record<string, unknown> = {};
      const results = await Promise.all(node.steps.map((s) => execStep(s, cursor, ctx)));
      for (let i = 0; i < node.steps.length; i++) {
        const s = node.steps[i] as Step<unknown, unknown>;
        const r = results[i] as Awaited<ReturnType<typeof execStep>>;
        if ('suspended' in r) return { ok: false, suspended: r.suspended, outputs: ctx.outputs };
        if (!r.ok) return { ok: false, failedAt: s.id, error: r.error, outputs: ctx.outputs };
        out[s.id] = r.value;
      }
      cursor = out;
    } else if (node.kind === 'branch') {
      const arm = node.predicate(ctx.outputs);
      const body = node.arms[arm] ?? [];
      for (const s of body) {
        const r = await execStep(s, cursor, ctx);
        if ('suspended' in r) return { ok: false, suspended: r.suspended, outputs: ctx.outputs };
        if (!r.ok) return { ok: false, failedAt: s.id, error: r.error, outputs: ctx.outputs };
        cursor = r.value;
      }
    } else if (node.kind === 'loop') {
      let iter = 0;
      while (node.condition(ctx.outputs) && iter < node.maxIters) {
        for (const s of node.body) {
          const r = await execStep(s, cursor, ctx);
          if ('suspended' in r) return { ok: false, suspended: r.suspended, outputs: ctx.outputs };
          if (!r.ok) return { ok: false, failedAt: s.id, error: r.error, outputs: ctx.outputs };
          cursor = r.value;
        }
        iter++;
      }
      if (iter >= node.maxIters && node.condition(ctx.outputs)) {
        return { ok: false, failedAt: 'loop', error: `max iterations (${node.maxIters}) exceeded`, outputs: ctx.outputs };
      }
    }
  }
  return { ok: true, output: def.finalize(ctx.outputs), outputs: ctx.outputs };
}

type StepResult = ({ ok: true; value: unknown } | { ok: false; error: string }) | { suspended: { stepId: string; reason: string } };

async function execStep(step: Step<unknown, unknown>, input: unknown, ctx: WorkflowCtx): Promise<StepResult> {
  ctx.bus?.publish({ kind: 'tool.start', runId: ctx.runId, at: Date.now(), tool: `workflow:${step.id}`, argsSummary: summarize(input) });
  try {
    const r = await step.run(input, ctx);
    if (r.ok) {
      ctx.outputs[step.id] = r.value;
      ctx.bus?.publish({ kind: 'tool.result', runId: ctx.runId, at: Date.now(), tool: `workflow:${step.id}`, ok: true, summary: 'ok' });
      return { ok: true, value: r.value };
    }
    ctx.bus?.publish({ kind: 'tool.result', runId: ctx.runId, at: Date.now(), tool: `workflow:${step.id}`, ok: false, summary: r.error });
    return { ok: false, error: r.error };
  } catch (e) {
    if (e instanceof WorkflowSuspended) {
      ctx.suspended = { stepId: e.stepId, reason: e.reason };
      ctx.bus?.publish({ kind: 'tool.result', runId: ctx.runId, at: Date.now(), tool: `workflow:${step.id}`, ok: false, summary: `suspended: ${e.reason}` });
      return { suspended: ctx.suspended };
    }
    const msg = e instanceof Error ? e.message : String(e);
    ctx.bus?.publish({ kind: 'tool.result', runId: ctx.runId, at: Date.now(), tool: `workflow:${step.id}`, ok: false, summary: msg });
    return { ok: false, error: msg };
  }
}

const summarize = (v: unknown): string => {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 79)}…` : s;
  } catch {
    return String(v);
  }
};

/** Suspend the current step. The runtime returns control to the caller. */
export function suspend(stepId: string, reason: string): never {
  throw new WorkflowSuspended(stepId, reason);
}

/** Resume a previously-suspended workflow with the user's resolution. */
export async function resumeWorkflow<I, O>(def: WorkflowDef<I, O>, ctx: WorkflowCtx, resolution: Record<string, unknown>): Promise<RunResult<O>> {
  Object.assign(ctx.outputs, resolution);
  // The user-provided resolution stands in for the suspended step's output;
  // we restart from where we left off by skipping nodes whose step ids are
  // already in `outputs`. For the v2 substrate this is sufficient — a richer
  // resume would persist the cursor.
  const remaining: WorkflowDef<I, O>['nodes'] = [];
  let resumeStarted = false;
  for (const node of def.nodes) {
    if (!resumeStarted && node.kind === 'step' && node.step.id in ctx.outputs) continue;
    resumeStarted = true;
    remaining.push(node);
  }
  const subDef: WorkflowDef<I, O> = { ...def, nodes: remaining, start: () => ctx.outputs };
  ctx.suspended = undefined as never;
  return runWorkflow(subDef, undefined as unknown as I, ctx);
}
