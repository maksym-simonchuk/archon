import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlanStep, Task, Verdict } from '../core/types';
import { AuditLog } from '../effecting/audit-log';
import { CapabilityBroker } from '../effecting/capability-broker';
import { loadPolicy, PolicyEngine } from '../effecting/policy-engine';
import { Transaction } from '../effecting/transaction';
import { MemoryStore } from '../memory/store';
import { TaskJournal } from '../services/task-journal';
import { Executor } from './executor';
import { CognitionLoop, type CognitionLoopDeps } from './loop';
import { Planner } from './planner';
import { Reflector } from './reflector';
import { ScaffoldStrategy } from './scaffold-strategy';
import type { CognitivePlan, PlanStrategy } from './types';
import { Verifier } from './verifier';

const execFileAsync = promisify(execFile);
const doc = loadPolicy(readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8'));

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archon-cog-'));
  const git = (args: string[]): Promise<unknown> => execFileAsync('git', args, { cwd: dir });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'archon@local']);
  await git(['config', 'user.name', 'archon']);
  await writeFile(join(dir, 'seed.txt'), 'seed\n');
  await git(['add', '-A']);
  await git(['commit', '-m', 'init']);
  return dir;
}

function loopFor(
  repo: string,
  worktrees: string,
  strategy: PlanStrategy,
  memory: MemoryStore,
  journal: TaskJournal,
  cost?: () => number,
  verifierPlugins?: (files: string[]) => Promise<Verdict[]>,
  preApply?: CognitionLoopDeps['preApply'],
): CognitionLoop {
  const audit = new AuditLog();
  // `trusted` so worktree/merge git ops are permitted; the broker still gates each.
  const brokerAt = (cwd: string): CapabilityBroker =>
    new CapabilityBroker(new PolicyEngine(doc, 'trusted'), audit, cwd);
  return new CognitionLoop({
    planner: new Planner(strategy),
    transaction: new Transaction(brokerAt(repo), repo, worktrees),
    reflector: new Reflector(memory),
    journal,
    executorFor: (worktree, taskId) => new Executor(brokerAt(worktree), taskId),
    verifierFor: (worktree) => new Verifier(brokerAt(worktree)),
    verifierPlugins,
    preApply,
    cost,
  });
}

const task = (goal: string): Task => ({
  id: `t${Date.now().toString(36)}`,
  goal,
  profile: 'trusted',
  createdAt: new Date().toISOString(),
});

let repo: string | undefined;
let wt: string | undefined;
afterEach(async () => {
  for (const d of [repo, wt]) if (d) await rm(d, { recursive: true, force: true });
  repo = wt = undefined;
});

describe('ScaffoldStrategy (M6)', () => {
  it('produces two reversible write steps and a verifying check', async () => {
    const cog = await new ScaffoldStrategy().propose(task('add function greet'), '');
    expect(cog.plan.steps).toHaveLength(2);
    expect(cog.plan.steps.every((s) => s.reversible)).toBe(true);
    expect(Object.keys(cog.actions)).toHaveLength(2);
    expect(cog.checks[0]?.argv).toEqual(['node', 'archon-demo/greet.test.mjs']);
  });
});

describe('CognitionLoop (M6)', () => {
  it('runs a trivial task end-to-end and merges verified work', async () => {
    repo = await initRepo();
    wt = await mkdtemp(join(tmpdir(), 'archon-cwt-'));
    const memory = new MemoryStore(':memory:');
    const journal = new TaskJournal(':memory:');
    const t = task('add function greet');
    const results = await loopFor(repo, wt, new ScaffoldStrategy(), memory, journal, () => 0.0042).run(t);

    expect(results.every((r) => r.verdict.passed)).toBe(true);
    expect(results[results.length - 1]?.stepId).toContain('verify');
    expect(await exists(join(repo, 'archon-demo', 'greet.mjs'))).toBe(true);
    expect(memory.recall('episodic', 'add function greet')).toHaveLength(1);

    const entries = await journal.replay(t.id);
    expect(entries.map((e) => e.kind)).toEqual(
      ['plan', 'step', 'diff', 'step', 'diff', 'verdict', 'decision', 'cost'],
    );
    expect((entries.find((e) => e.kind === 'decision')?.payload as { merged: boolean }).merged).toBe(true);
    expect((entries.find((e) => e.kind === 'cost')?.payload as { usd: number }).usd).toBe(0.0042);
    memory.close();
    journal.close();
  });

  it('discards on failed verify, leaving the main tree untouched', async () => {
    repo = await initRepo();
    wt = await mkdtemp(join(tmpdir(), 'archon-cwt-'));
    const memory = new MemoryStore(':memory:');
    const journal = new TaskJournal(':memory:');

    // Writes a real file (the step passes), then a check that always exits non-zero.
    const failing: PlanStrategy = {
      propose: async (t): Promise<CognitivePlan> => {
        const target = 'archon-demo/x.mjs';
        const step: PlanStep = {
          id: `${t.id}-s1`,
          intent: `create ${target}`,
          capability: { action: 'fs.write', target, blastRadius: { files: [target], symbols: [], escapesRepo: false }, reason: 'x' },
          reversible: true,
        };
        return {
          plan: { taskId: t.id, rationale: 'write, then fail verify', steps: [step] },
          actions: { [step.id]: { kind: 'write', target, content: 'export const x = 1;\n' } },
          checks: [{ name: 'always-fails', argv: ['node', '-e', 'process.exit(1)'] }],
        };
      },
    };

    const results = await loopFor(repo, wt, failing, memory, journal).run(task('bad task'));
    expect(results.some((r) => !r.verdict.passed)).toBe(true);
    expect(await exists(join(repo, 'archon-demo', 'x.mjs'))).toBe(false); // never merged
    memory.close();
    journal.close();
  });

  it('folds a passing verifier-plugin verdict into a clean run (additive, still merges)', async () => {
    repo = await initRepo();
    wt = await mkdtemp(join(tmpdir(), 'archon-cwt-'));
    const memory = new MemoryStore(':memory:');
    const journal = new TaskJournal(':memory:');
    const seen: string[][] = [];
    const passing = async (files: string[]): Promise<Verdict[]> => {
      seen.push(files);
      return [{ passed: true, checks: [{ name: 'plugin:ok', passed: true }] }];
    };
    const results = await loopFor(repo, wt, new ScaffoldStrategy(), memory, journal, undefined, passing).run(
      task('add function greet'),
    );

    const verify = results.find((r) => r.stepId.includes('verify'));
    expect(verify?.verdict.passed).toBe(true);
    expect(verify?.verdict.checks.some((c) => c.name === 'plugin:ok')).toBe(true); // plugin checks accumulate
    expect(seen[0]?.length).toBeGreaterThan(0); // the plugin received the run's changed files
    expect(await exists(join(repo, 'archon-demo', 'greet.mjs'))).toBe(true); // merged
    memory.close();
    journal.close();
  });

  it('discards an otherwise-clean run when a verifier plugin vetoes it (plugins only tighten)', async () => {
    repo = await initRepo();
    wt = await mkdtemp(join(tmpdir(), 'archon-cwt-'));
    const memory = new MemoryStore(':memory:');
    const journal = new TaskJournal(':memory:');
    // Built-in checks pass, but a plugin verdict fails — AND must discard the run.
    const veto = async (): Promise<Verdict[]> => [
      { passed: false, checks: [{ name: 'plugin:veto', passed: false, output: 'rejected by plugin' }] },
    ];
    const results = await loopFor(repo, wt, new ScaffoldStrategy(), memory, journal, undefined, veto).run(
      task('add function greet'),
    );

    const verify = results.find((r) => r.stepId.includes('verify'));
    expect(verify?.verdict.passed).toBe(false);
    expect(verify?.verdict.checks.some((c) => c.name === 'plugin:veto')).toBe(true);
    expect(await exists(join(repo, 'archon-demo', 'greet.mjs'))).toBe(false); // vetoed ⇒ never merged
    memory.close();
    journal.close();
  });

  it('aborts before any worktree when a pre-apply hook blocks (M19 gate)', async () => {
    repo = await initRepo();
    wt = await mkdtemp(join(tmpdir(), 'archon-cwt-'));
    const memory = new MemoryStore(':memory:');
    const journal = new TaskJournal(':memory:');
    const seen: { target: string; content: string }[][] = [];
    // A gate that blocks the planned write outright.
    const block: CognitionLoopDeps['preApply'] = async (writes) => {
      seen.push(writes);
      return [{ hook: 'never-modify', severity: 'block', subject: writes[0]?.target ?? '?', detail: 'sensitive zone' }];
    };
    const t = task('add function greet');
    const results = await loopFor(repo, wt, new ScaffoldStrategy(), memory, journal, undefined, undefined, block).run(t);

    expect(results).toHaveLength(1);
    expect(results[0]?.stepId).toContain('prehook');
    expect(results[0]?.verdict.passed).toBe(false);
    expect(seen[0]?.length).toBeGreaterThan(0); // the gate saw the planned writes
    expect(await exists(join(repo, 'archon-demo', 'greet.mjs'))).toBe(false); // nothing written

    const entries = await journal.replay(t.id);
    expect(entries.map((e) => e.kind)).toEqual(['plan', 'verdict', 'decision']); // no step/diff — never opened a worktree
    memory.close();
    journal.close();
  });

  it('proceeds normally when the pre-apply gate returns no blocking findings', async () => {
    repo = await initRepo();
    wt = await mkdtemp(join(tmpdir(), 'archon-cwt-'));
    const memory = new MemoryStore(':memory:');
    const journal = new TaskJournal(':memory:');
    // A gate that only warns — the run must still merge.
    const warnOnly: CognitionLoopDeps['preApply'] = async () => [
      { hook: 'boundary-leak', severity: 'warn', subject: 'a → b', detail: 'internal import' },
    ];
    const results = await loopFor(repo, wt, new ScaffoldStrategy(), memory, journal, undefined, undefined, warnOnly).run(
      task('add function greet'),
    );
    expect(results.every((r) => r.verdict.passed)).toBe(true);
    expect(await exists(join(repo, 'archon-demo', 'greet.mjs'))).toBe(true); // merged
    memory.close();
    journal.close();
  });
});
