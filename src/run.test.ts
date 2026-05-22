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

  it('emits a machine-readable report under --json', async () => {
    const log = captured();
    await cmdRun(
      fakeRt([
        {
          stepId: 's1',
          diff: { files: ['src/widget.ts'], added: 3, removed: 0, patch: '' },
          verdict: { passed: false, checks: [{ name: 'typecheck', passed: false, output: 'boom' }] },
        },
      ]),
      'add a widget',
      { json: true },
    );
    const report = JSON.parse(text(log)); // stdout is exactly one JSON document

    expect(report.goal).toBe('add a widget');
    expect(report.taskId).toMatch(/^t-[a-z0-9]+$/);
    expect(report.merged).toBe(false); // the only step failed
    expect(report.steps).toEqual([
      { stepId: 's1', passed: false, files: ['src/widget.ts'], failingChecks: ['typecheck'] },
    ]);
  });
});
