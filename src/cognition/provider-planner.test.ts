import { describe, expect, it } from 'vitest';
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

/** A router whose only client returns `text` verbatim for any prompt. */
const routerReturning = (text: string): ProviderRouter => {
  const client: ProviderClient = {
    provider: 'fake',
    complete: async () => ({ text, inputTokens: 1, outputTokens: 1 }),
  };
  return new ProviderRouter([model], [client]);
};

const VALID = JSON.stringify({
  rationale: 'write a foo module and self-test it',
  steps: [
    { intent: 'write foo', action: { kind: 'write', target: 'src/foo.mjs', content: 'export const foo = () => 1;' } },
  ],
  checks: [{ name: 'foo-test', argv: ['node', 'src/foo.test.mjs'] }],
});

describe('ProviderPlanner (LLM-backed plan strategy)', () => {
  it('parses a structured plan into a CognitivePlan with broker-gated steps', async () => {
    const cog = await new ProviderPlanner(routerReturning(VALID)).propose(task, 'ctx');

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

  it('tolerates a ```json fenced or prose-wrapped completion', async () => {
    const fenced = await new ProviderPlanner(routerReturning('```json\n' + VALID + '\n```')).propose(task, '');
    expect(fenced.plan.steps[0].capability.target).toBe('src/foo.mjs');

    const prose = await new ProviderPlanner(
      routerReturning(`Sure, here is the plan:\n${VALID}\nLet me know if that works.`),
    ).propose(task, '');
    expect(prose.plan.steps).toHaveLength(1);
  });

  it('throws when the model does not return valid JSON', async () => {
    await expect(new ProviderPlanner(routerReturning('I cannot do that.')).propose(task, '')).rejects.toThrow(
      /valid JSON/,
    );
  });

  it('throws when the JSON does not match the plan schema', async () => {
    const offSchema = JSON.stringify({ rationale: 'r', steps: 'not-an-array', checks: [] });
    await expect(new ProviderPlanner(routerReturning(offSchema)).propose(task, '')).rejects.toThrow(/schema/);

    const badStep = JSON.stringify({ rationale: 'r', steps: [{ intent: 'x' }], checks: [] });
    await expect(new ProviderPlanner(routerReturning(badStep)).propose(task, '')).rejects.toThrow(/schema/);
  });
});
