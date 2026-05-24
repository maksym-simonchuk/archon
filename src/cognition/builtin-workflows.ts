/**
 * Built-in workflow definitions registered with the WorkflowRegistry on
 * Runtime boot. These are intentionally tiny — they exist so `/workflow`
 * has something to drive on a fresh repo, and they exercise the bus events
 * the UI subscribes to.
 *
 * Step bodies stay pure: any side effect a step needs comes through the
 * Capability Broker (passed in via ctx-side adapters), never via direct fs
 * imports. The substrate stays authority-free.
 */

import { type WorkflowDef, createStep, createWorkflow } from './workflow';

/**
 * Repo-doctor workflow: parallel quick checks then a one-line synthesis.
 * Pure compute — exists to demonstrate the parallel/then DAG shape.
 */
export function buildRepoDoctorWorkflow(): WorkflowDef<unknown, { summary: string; checks: Record<string, boolean> }> {
  const checkTypecheck = createStep<unknown, { name: string; ok: boolean }>('check.typecheck', async () => ({
    ok: true,
    value: { name: 'typecheck', ok: true },
  }));
  const checkTests = createStep<unknown, { name: string; ok: boolean }>('check.tests', async () => ({
    ok: true,
    value: { name: 'tests', ok: true },
  }));
  const checkLint = createStep<unknown, { name: string; ok: boolean }>('check.lint', async () => ({
    ok: true,
    value: { name: 'lint', ok: true },
  }));

  return createWorkflow<unknown>('repo-doctor')
    .parallel(checkTypecheck, checkTests, checkLint)
    .build((outputs) => {
      const checks: Record<string, boolean> = {};
      for (const k of ['check.typecheck', 'check.tests', 'check.lint'] as const) {
        const v = outputs[k] as { name: string; ok: boolean } | undefined;
        if (v) checks[v.name] = v.ok;
      }
      const allOk = Object.values(checks).every(Boolean);
      return { summary: allOk ? 'all checks passed' : 'some checks failed', checks };
    });
}
