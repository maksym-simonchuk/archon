import { describe, expect, it } from 'vitest';
import { createEventBus, type ArchonEvent } from '../services/event-bus';
import { createStep, createWorkflow, resumeWorkflow, runWorkflow, suspend, type WorkflowCtx } from './workflow';

const newCtx = (runId = 'r'): WorkflowCtx => ({ runId, outputs: {} });

describe('workflow DAG runtime', () => {
  it('runs a linear sequence and threads values through', async () => {
    const wf = createWorkflow<number>('w')
      .then(createStep<number, number>('double', async (n) => ({ ok: true, value: n * 2 })))
      .then(createStep<number, number>('plus1', async (n) => ({ ok: true, value: n + 1 })))
      .build<number>((o) => o['plus1'] as number);
    const r = await runWorkflow(wf, 5, newCtx());
    expect(r.ok).toBe(true);
    expect(r.output).toBe(11);
  });

  it('stops at the first failure and surfaces `failedAt`', async () => {
    const wf = createWorkflow<number>('w')
      .then(createStep<number, number>('ok', async (n) => ({ ok: true, value: n + 1 })))
      .then(createStep<number, number>('bad', async () => ({ ok: false, error: 'boom' })))
      .then(createStep<number, number>('never', async () => ({ ok: true, value: 0 })))
      .build<number>((o) => (o['ok'] as number) ?? 0);
    const r = await runWorkflow(wf, 1, newCtx());
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe('bad');
    expect(r.outputs['never']).toBeUndefined();
  });

  it('parallel runs all steps and aggregates outputs by id', async () => {
    const wf = createWorkflow<number>('w')
      .parallel(
        createStep<number, number>('a', async (n) => ({ ok: true, value: n + 1 })),
        createStep<number, number>('b', async (n) => ({ ok: true, value: n * 10 })),
      )
      .build<{ a: number; b: number }>((o) => ({ a: o['a'] as number, b: o['b'] as number }));
    const r = await runWorkflow(wf, 3, newCtx());
    expect(r.ok).toBe(true);
    expect(r.output).toEqual({ a: 4, b: 30 });
  });

  it('publishes tool.start / tool.result events on the bus', async () => {
    const bus = createEventBus();
    const events: ArchonEvent[] = [];
    const iter = bus.subscribe()[Symbol.asyncIterator]();
    const collect = (async () => {
      while (true) {
        const next = await iter.next();
        if (next.done) break;
        events.push(next.value);
      }
    })();
    const wf = createWorkflow<number>('w')
      .then(createStep<number, number>('s', async (n) => ({ ok: true, value: n })))
      .build<number>((o) => o['s'] as number);
    await runWorkflow(wf, 7, { runId: 'r', bus, outputs: {} });
    bus.close();
    await collect;
    expect(events.find((e) => e.kind === 'tool.start' && (e as { tool: string }).tool === 'workflow:s')).toBeDefined();
    expect(events.find((e) => e.kind === 'tool.result' && (e as { tool: string }).tool === 'workflow:s')).toBeDefined();
  });

  it('suspend pauses the workflow and resumeWorkflow continues from the resolution', async () => {
    const wf = createWorkflow<number>('w')
      .then(createStep<number, number>('begin', async (n) => ({ ok: true, value: n + 1 })))
      .then(createStep<number, number>('approval', async () => suspend('approval', 'needs user approval')))
      .then(createStep<number, number>('finish', async (_n, ctx) => ({ ok: true, value: (ctx.outputs['approval'] as number) + 100 })))
      .build<number>((o) => o['finish'] as number);
    const ctx = newCtx();
    const r1 = await runWorkflow(wf, 1, ctx);
    expect(r1.ok).toBe(false);
    expect(r1.suspended?.stepId).toBe('approval');
    // User resolves with value 42.
    const r2 = await resumeWorkflow(wf, ctx, { approval: 42 });
    expect(r2.ok).toBe(true);
    expect(r2.output).toBe(142);
  });

  it('dowhile loops up to maxIters and fails if the condition still holds', async () => {
    const ctx = newCtx();
    const wf = createWorkflow<number>('w')
      .dowhile(
        () => true,
        [createStep<unknown, number>('tick', async (_v) => ({ ok: true, value: ((ctx.outputs['tick'] as number | undefined) ?? 0) + 1 }))],
        3,
      )
      .build<number>((o) => o['tick'] as number);
    const r = await runWorkflow(wf, 0, ctx);
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe('loop');
  });
});
