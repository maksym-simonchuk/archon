import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntime, type Runtime } from '../runtime';
import { runCouncilCommand } from './council-command';

const POLICY = readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8');

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Offline runtime — no providers, so both notional voters fold into the
 *  scaffolder. The council still runs (single voter) and reports it. */
async function offlineRuntime(): Promise<Runtime> {
  dir = await mkdtemp(join(tmpdir(), 'archon-council-'));
  await mkdir(join(dir, '.archon'), { recursive: true });
  await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
  return buildRuntime(dir);
}

describe('runCouncilCommand', () => {
  it('runs a single-voter council when no LLM planner is configured', async () => {
    const rt = await offlineRuntime();
    try {
      const report = await runCouncilCommand(rt, 'add a greeter');
      // Offline runtime → only the scaffolder votes; the LLM cross-check is
      // skipped (it would be an identical twin), so voters.length === 1.
      expect(report.llmPlanning).toBe(false);
      expect(report.voters).toHaveLength(1);
      expect(report.voters[0]?.name).toBe('scaffold');
      // The winner is the only proposal; synthesise() never throws on N=1.
      expect(report.outcome.winner.planner).toBe('scaffold');
      expect(report.outcome.agreement).toBe(1);
      expect(report.outcome.totalCostUsd).toBe(0);
    } finally {
      rt.close();
    }
  });

  it('uses the rationale field to summarise the synthesiser score', async () => {
    const rt = await offlineRuntime();
    try {
      const report = await runCouncilCommand(rt, 'render a button');
      // synthesise() emits "score=… · agreement=N/M · cost=$…" — invariant
      // worth asserting so the shell-side renderer can rely on the shape.
      expect(report.outcome.rationale).toMatch(/score=/);
      expect(report.outcome.rationale).toMatch(/agreement=\d+\/\d+/);
      expect(report.outcome.rationale).toMatch(/cost=\$/);
    } finally {
      rt.close();
    }
  });

  it('builds an OpenSpecChange for every proposal from the plan rationale', async () => {
    const rt = await offlineRuntime();
    try {
      const report = await runCouncilCommand(rt, 'export greet');
      // Each voter's proposal carries a derived OpenSpecChange — id comes
      // from the plan's taskId (slugged) so it stays deterministic.
      expect(report.outcome.winner.change.id).toMatch(/^[a-z0-9-]+$/);
      expect(report.outcome.winner.change.proposal.why.length).toBeGreaterThan(0);
      // The scaffolder always emits at least one step intent, so the change
      // surfaces at least one task line — guards against an empty proposal.
      expect(report.outcome.winner.change.tasks.length).toBeGreaterThan(0);
    } finally {
      rt.close();
    }
  });
});
