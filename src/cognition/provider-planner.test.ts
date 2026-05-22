import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ModelSpec, Task } from '../core/types';
import { ProviderRouter, type ProviderClient } from '../services/provider-router';
import { ProviderPlanner } from './provider-planner';

const task: Task = { id: 't1', goal: 'add a foo helper', profile: 'safe', createdAt: '2026-01-01T00:00:00Z' };

const model: ModelSpec = {
  id: 'm',
  provider: 'fake',
  contextWindow: 1000,
  costPer1kInput: 0,
  costPer1kOutput: 0,
  strengths: ['plan'],
};

/**
 * A router whose client validates a fixed payload through the planner's schema
 * — exactly what the real SDK-backed client does (provider emits JSON, the SDK
 * validates against the schema). A payload that violates the schema throws at
 * `schema.parse`, mirroring a real schema rejection at the provider boundary.
 */
const routerReturning = (payload: unknown): ProviderRouter => {
  const client: ProviderClient = {
    provider: 'fake',
    complete: async () => ({ text: '', inputTokens: 1, outputTokens: 1 }),
    completeObject: async <T,>(_m: ModelSpec, _p: string, _mt: number, schema: z.ZodType<T>) => ({
      object: schema.parse(payload),
      inputTokens: 1,
      outputTokens: 1,
    }),
  };
  return new ProviderRouter([model], [client]);
};

const VALID_PLAN = {
  rationale: 'write a foo module and self-test it',
  steps: [
    { intent: 'write foo', action: { kind: 'write', target: 'src/foo.mjs', content: 'export const foo = () => 1;' } },
  ],
  checks: [{ name: 'foo-test', argv: ['node', 'src/foo.test.mjs'] }],
};

describe('ProviderPlanner (LLM-backed plan strategy)', () => {
  it('maps a schema-validated plan into a CognitivePlan with broker-gated steps', async () => {
    const cog = await new ProviderPlanner(routerReturning(VALID_PLAN)).propose(task, 'ctx');

    expect(cog.plan.taskId).toBe('t1');
    expect(cog.plan.rationale).toBe('write a foo module and self-test it');
    expect(cog.plan.steps).toHaveLength(1);

    const step = cog.plan.steps[0];
    expect(step.id).toBe('t1-s1');
    expect(step.intent).toBe('write foo');
    expect(step.reversible).toBe(true);
    expect(step.capability.action).toBe('fs.write');
    expect(step.capability.target).toBe('src/foo.mjs');
    expect(step.capability.blastRadius).toEqual({ files: ['src/foo.mjs'], symbols: [], escapesRepo: false });

    expect(cog.actions['t1-s1']).toEqual({
      kind: 'write',
      target: 'src/foo.mjs',
      content: 'export const foo = () => 1;',
    });
    expect(cog.checks).toEqual([{ name: 'foo-test', argv: ['node', 'src/foo.test.mjs'] }]);
  });

  it('rejects when the provider payload violates the plan schema', async () => {
    const offSchema = { rationale: 'r', steps: 'not-an-array', checks: [] };
    await expect(new ProviderPlanner(routerReturning(offSchema)).propose(task, '')).rejects.toThrow();

    const badStep = { rationale: 'r', steps: [{ intent: 'x' }], checks: [] }; // step missing `action`
    await expect(new ProviderPlanner(routerReturning(badStep)).propose(task, '')).rejects.toThrow();
  });
});
