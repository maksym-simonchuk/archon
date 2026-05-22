import { describe, expect, it } from 'vitest';
import {
  type DeclaredPhase,
  type ExecutableSkill,
  type PhaseStatus,
  formatSkillRun,
  runSkill,
} from './skill-runtime';

/** A phase that records it ran and returns a fixed outcome. */
const phase = (
  ran: string[],
  name: DeclaredPhase,
  status: PhaseStatus,
  detail: string = name,
): ExecutableSkill['steps'][number] => ({
  phase: name,
  run: async () => {
    ran.push(name);
    return { status, detail };
  },
});

const skill = (steps: ExecutableSkill['steps']): ExecutableSkill => ({
  name: 'safe-refactor',
  description: 'test skill',
  steps,
});

describe('runSkill', () => {
  it('runs every phase in order and marks applied when execute merges', async () => {
    const ran: string[] = [];
    const run = await runSkill(
      skill([
        phase(ran, 'analyze', 'ok'),
        phase(ran, 'simulate', 'ok'),
        phase(ran, 'validate', 'ok'),
        phase(ran, 'execute', 'ok'),
      ]),
    );
    expect(ran).toEqual(['analyze', 'simulate', 'validate', 'execute']);
    expect(run.applied).toBe(true);
    expect(run.haltedAt).toBeUndefined();
    expect(run.outcomes.map((o) => o.phase)).toEqual(['analyze', 'simulate', 'validate', 'execute']);
  });

  it('short-circuits at a blocked gate and runs nothing downstream', async () => {
    const ran: string[] = [];
    const run = await runSkill(
      skill([
        phase(ran, 'analyze', 'ok'),
        phase(ran, 'simulate', 'blocked', 'regression predicted'),
        phase(ran, 'execute', 'ok'),
      ]),
    );
    expect(ran).toEqual(['analyze', 'simulate']); // execute never ran
    expect(run.applied).toBe(false);
    expect(run.haltedAt).toBe('simulate');
    expect(run.outcomes.at(-1)).toEqual({ phase: 'simulate', status: 'blocked', detail: 'regression predicted' });
  });

  it('halts on a failed precondition before execute', async () => {
    const ran: string[] = [];
    const run = await runSkill(skill([phase(ran, 'analyze', 'failed', 'no proposals')]));
    expect(ran).toEqual(['analyze']);
    expect(run.haltedAt).toBe('analyze');
    expect(run.applied).toBe(false);
  });

  it('synthesises a rollback outcome when execute fails (verify discarded the worktree)', async () => {
    const ran: string[] = [];
    const run = await runSkill(
      skill([phase(ran, 'analyze', 'ok'), phase(ran, 'execute', 'failed', 'verify failed')]),
    );
    expect(run.applied).toBe(false);
    expect(run.haltedAt).toBe('execute');
    const last = run.outcomes.at(-1);
    expect(last?.phase).toBe('rollback');
    expect(last?.status).toBe('ok');
    expect(last?.detail).toContain('working tree untouched');
  });

  it('continues past a skipped phase without halting', async () => {
    const ran: string[] = [];
    const run = await runSkill(
      skill([phase(ran, 'analyze', 'ok'), phase(ran, 'simulate', 'skipped', 'new file'), phase(ran, 'execute', 'ok')]),
    );
    expect(ran).toEqual(['analyze', 'simulate', 'execute']);
    expect(run.applied).toBe(true);
  });

  it('treats a skill with no execute phase as not applied (read-only)', async () => {
    const ran: string[] = [];
    const run = await runSkill(skill([phase(ran, 'analyze', 'ok'), phase(ran, 'simulate', 'ok')]));
    expect(run.applied).toBe(false);
    expect(run.haltedAt).toBeUndefined();
  });

  it('passes prior outcomes to each phase', async () => {
    const seen: number[] = [];
    await runSkill(
      skill([
        { phase: 'analyze', run: async (prior) => (seen.push(prior.length), { status: 'ok', detail: 'a' }) },
        { phase: 'execute', run: async (prior) => (seen.push(prior.length), { status: 'ok', detail: 'e' }) },
      ]),
    );
    expect(seen).toEqual([0, 1]); // analyze sees none; execute sees analyze's outcome
  });
});

describe('formatSkillRun', () => {
  it('renders an aligned phase trace ending in the applied verdict', async () => {
    const run = await runSkill(
      skill([phase([], 'analyze', 'ok', 'selected break-cycle a ↔ b'), phase([], 'execute', 'ok', 'merged')]),
    );
    const out = formatSkillRun(run);
    expect(out).toContain('skill: safe-refactor');
    expect(out).toContain('✓ analyze');
    expect(out).toContain('selected break-cycle a ↔ b');
    expect(out).toContain('→ applied — change merged');
  });

  it('shows the halting phase when blocked', async () => {
    const run = await runSkill(skill([phase([], 'simulate', 'blocked', 'never-modify zone')]));
    const out = formatSkillRun(run);
    expect(out).toContain('⛔ simulate');
    expect(out).toContain('→ not applied — halted at simulate');
  });
});
