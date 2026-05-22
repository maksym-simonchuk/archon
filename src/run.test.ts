import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdRun } from './commands';
import type { CognitionLoop } from './cognition/loop';
import type { StepResult } from './core/types';
import type { Runtime } from './runtime';

afterEach(() => vi.restoreAllMocks());

const captured = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
const text = (log: ReturnType<typeof captured>): string => log.mock.calls.flat().join('\n');

/**
 * A runtime whose loop yields `results` without opening a real worktree, so we
 * can assert cmdRun's framing (task id + replay pointer) in isolation. The
 * offline path (`llmPlanning: false`) keeps planContext from touching the broker.
 */
const fakeRt = (results: StepResult[]): Runtime =>
  ({
    llmPlanning: false,
    config: { profile: 'trusted' },
    context: async () => '',
    loop: () => ({ run: async () => results }) as unknown as CognitionLoop,
  }) as unknown as Runtime;

describe('cmdRun (task framing)', () => {
  it('prints the task id up front and a matching replay pointer after the results', async () => {
    const log = captured();
    await cmdRun(fakeRt([{ stepId: 's1', verdict: { passed: true, checks: [] } }]), 'add a widget');
    const out = text(log);

    expect(out).toContain('run: merged (verified)');
    const id = out.match(/run (t-[a-z0-9]+): add a widget/)?.[1];
    expect(id).toBeDefined(); // the id is surfaced before the run, with the goal
    expect(out).toContain(`replay: archon status ${id}`); // the pointer targets that same run
  });

  it('still points at the run when it is discarded (so the partial journal is reachable)', async () => {
    const log = captured();
    await cmdRun(fakeRt([{ stepId: 's1', verdict: { passed: false, checks: [] } }]), 'break a thing');
    const out = text(log);

    expect(out).toContain('run: discarded');
    expect(out).toMatch(/replay: archon status t-[a-z0-9]+/);
  });
});
