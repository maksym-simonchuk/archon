import { describe, expect, it } from 'vitest';

import { createEventBus } from '../services/event-bus';
import { buildRepoDoctorWorkflow } from './builtin-workflows';
import { createStep, createWorkflow, suspend } from './workflow';
import { WorkflowRegistry } from './workflow-registry';

describe('WorkflowRegistry', () => {
  it('lists nothing until a workflow is registered', () => {
    const reg = new WorkflowRegistry(createEventBus());
    expect(reg.list()).toEqual([]);
  });

  it('runs the built-in repo-doctor workflow and produces a summary', async () => {
    const reg = new WorkflowRegistry(createEventBus());
    reg.register(buildRepoDoctorWorkflow(), 'demo');
    const out = await reg.run('repo-doctor', {});
    expect(out).toBeDefined();
    expect(out?.result.ok).toBe(true);
    const summary = (out?.result.output as { summary: string } | undefined)?.summary;
    expect(summary).toBe('all checks passed');
  });

  it('returns undefined for an unknown workflow id', async () => {
    const reg = new WorkflowRegistry(createEventBus());
    const out = await reg.run('nope', {});
    expect(out).toBeUndefined();
  });

  it('records suspended runs and resumes them with the user resolution', async () => {
    const reg = new WorkflowRegistry(createEventBus());
    const stepA = createStep<unknown, string>('a', async () => ({ ok: true, value: 'a-out' }));
    const stepGate = createStep<unknown, { decided: string }>('gate', async () => {
      suspend('gate', 'awaiting user decision');
    });
    // Resume starts with cursor = ctx.outputs, so step `b` sees the whole
    // outputs map and reads the gate resolution from it.
    const stepB = createStep<unknown, string>('b', async (input) => {
      const gate = (input as Record<string, { decided?: string } | undefined>).gate;
      return { ok: true, value: `b(${gate?.decided ?? 'none'})` };
    });
    const def = createWorkflow<unknown>('two-stage')
      .then(stepA)
      .then(stepGate)
      .then(stepB)
      .build((outs) => outs['b'] as string);
    reg.register(def, 'gated demo');

    const first = await reg.run('two-stage', {});
    expect(first?.result.suspended?.stepId).toBe('gate');
    expect(reg.suspendedRuns().map((s) => s.runId)).toEqual([first?.runId]);

    const second = await reg.resume(first?.runId ?? '', { gate: { decided: 'yes' } });
    expect(second?.ok).toBe(true);
    expect(second?.output).toBe('b(yes)');
    expect(reg.suspendedRuns()).toEqual([]);
  });

  it('returns undefined when resuming a runId that was never suspended', async () => {
    const reg = new WorkflowRegistry(createEventBus());
    expect(await reg.resume('run_unknown', {})).toBeUndefined();
  });
});
