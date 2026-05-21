import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Verdict } from '../core/types';
import { AuditLog } from './audit-log';
import { CapabilityBroker } from './capability-broker';
import { loadPolicy, PolicyEngine } from './policy-engine';
import { Transaction } from './transaction';

const execFileAsync = promisify(execFile);
const doc = loadPolicy(readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8'));
const PASS: Verdict = { passed: true, checks: [] };
const FAIL: Verdict = { passed: false, checks: [{ name: 'tests', passed: false }] };

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archon-tx-'));
  const git = (args: string[]): Promise<unknown> => execFileAsync('git', args, { cwd: dir });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'archon@local']);
  await git(['config', 'user.name', 'archon']);
  await writeFile(join(dir, 'seed.txt'), 'seed\n');
  await git(['add', '-A']);
  await git(['commit', '-m', 'init']);
  return dir;
}

// `trusted` profile so worktree/merge are allowed; the broker still gates them.
function txFor(repo: string, worktrees: string): Transaction {
  const broker = new CapabilityBroker(new PolicyEngine(doc, 'trusted'), new AuditLog(), repo);
  return new Transaction(broker, repo, worktrees);
}

let repo: string | undefined;
let wt: string | undefined;
afterEach(async () => {
  for (const d of [repo, wt]) if (d) await rm(d, { recursive: true, force: true });
  repo = wt = undefined;
});

describe('Transaction (M4)', () => {
  it('merges verified work into the main tree', async () => {
    repo = await initRepo();
    wt = await mkdtemp(join(tmpdir(), 'archon-wt-'));
    const tx = txFor(repo, wt);

    const begun = await tx.begin('t1');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    await writeFile(join(begun.value.worktree, 'feature.ts'), 'export const f = 1;\n');
    expect((await tx.commitStep('feat: add feature')).ok).toBe(true);

    const fin = await tx.finalize(PASS);
    expect(fin.ok && fin.value).toBe('merged');
    expect(await readFile(join(repo, 'feature.ts'), 'utf8')).toContain('export const f');
  });

  it('discards on failed verify, leaving the main tree untouched', async () => {
    repo = await initRepo();
    wt = await mkdtemp(join(tmpdir(), 'archon-wt-'));
    const tx = txFor(repo, wt);

    const begun = await tx.begin('t2');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    await writeFile(join(begun.value.worktree, 'bad.ts'), 'oops\n');
    await tx.commitStep('wip: bad');

    const fin = await tx.finalize(FAIL);
    expect(fin.ok && fin.value).toBe('discarded');
    await expect(readFile(join(repo, 'bad.ts'), 'utf8')).rejects.toThrow();
  });
});
