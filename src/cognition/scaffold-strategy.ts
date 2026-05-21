import type { BlastRadius, PlanStep, Task } from '../core/types';
import type { CognitivePlan, PlanStrategy, StepAction } from './types';

const DEMO_DIR = 'archon-demo';
const STOPWORDS = new Set(['add', 'a', 'an', 'the', 'function', 'fn', 'create', 'make', 'new', 'to', 'and']);

/** Derive a valid JS identifier from the goal (last meaningful token); else `demo`. */
const symbolName = (goal: string): string => {
  const tokens = goal.match(/[A-Za-z_$][\w$]*/g) ?? [];
  const pick = [...tokens].reverse().find((t) => !STOPWORDS.has(t.toLowerCase()));
  return pick && /^[A-Za-z_$]/.test(pick) ? pick : 'demo';
};

const radius = (file: string): BlastRadius => ({ files: [file], symbols: [], escapesRepo: false });

/**
 * Deterministic, offline strategy: scaffold one function module plus a self-
 * checking test under `archon-demo/`. No model call — this is the trivial task
 * the M6 loop runs end-to-end (write impl + test, then self-verify by executing
 * the test with `node`, which needs no project dependencies in the worktree).
 * The LLM-backed strategy for arbitrary goals plugs into the same `PlanStrategy`
 * seam over the ProviderRouter (M7).
 */
export class ScaffoldStrategy implements PlanStrategy {
  async propose(task: Task, _context = ''): Promise<CognitivePlan> {
    const name = symbolName(task.goal);
    const implPath = `${DEMO_DIR}/${name}.mjs`;
    const testPath = `${DEMO_DIR}/${name}.test.mjs`;

    const impl: StepAction = {
      kind: 'write',
      target: implPath,
      content: `export const ${name} = () => '${name}';\n`,
    };
    const test: StepAction = {
      kind: 'write',
      target: testPath,
      content:
        `import assert from 'node:assert';\n` +
        `import { ${name} } from './${name}.mjs';\n` +
        `assert.strictEqual(${name}(), '${name}');\n` +
        `console.log('ok: ${name}');\n`,
    };

    const step = (n: number, intent: string, action: StepAction): PlanStep => ({
      id: `${task.id}-s${n}`,
      intent,
      capability: { action: 'fs.write', target: action.target, blastRadius: radius(action.target), reason: intent },
      reversible: true,
    });

    const s1 = step(1, `create ${implPath}`, impl);
    const s2 = step(2, `create ${testPath}`, test);

    return {
      plan: {
        taskId: task.id,
        rationale: `Scaffold ${name}() and a self-checking test, then verify by running the test.`,
        steps: [s1, s2],
      },
      actions: { [s1.id]: impl, [s2.id]: test },
      checks: [{ name: `test:${name}`, argv: ['node', testPath] }],
    };
  }
}
