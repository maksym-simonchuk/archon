import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from './core/types';
import { buildRuntime } from './runtime';

const POLICY = readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8');
const task: Task = { id: 'tt', goal: 'add a widget', profile: 'safe', createdAt: '2026-01-01T00:00:00Z' };

let dir: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A temp repo root with a valid `.archon/policy.yaml` and optional config. */
async function repo(config?: object): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'archon-rt-'));
  await mkdir(join(dir, '.archon'), { recursive: true });
  await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
  if (config) await writeFile(join(dir, 'archon.config.json'), JSON.stringify(config));
  return dir;
}

describe('buildRuntime (composition root)', () => {
  it('selects the deterministic scaffolder when no provider is configured', async () => {
    const runtime = await buildRuntime(await repo());
    try {
      expect(runtime.llmPlanning).toBe(false);
      expect(runtime.config.profile).toBe('safe');
      // The offline strategy must produce a runnable, verifiable plan with no network.
      const cog = await runtime.planner().plan(task);
      expect(cog.plan.steps.length).toBeGreaterThan(0);
      expect(cog.checks.length).toBeGreaterThan(0);
    } finally {
      runtime.close();
    }
  });

  it('activates the LLM planner when a provider is configured and its key is present', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const runtime = await buildRuntime(
      await repo({ providers: [{ id: 'anthropic', models: ['claude-haiku-4-5'] }] }),
    );
    try {
      expect(runtime.llmPlanning).toBe(true);
      expect(runtime.router.spent).toBe(0); // nothing charged just by wiring
    } finally {
      runtime.close();
    }
  });

  it('degrades to the scaffolder when the provider key is absent', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const runtime = await buildRuntime(
      await repo({ providers: [{ id: 'anthropic', models: ['claude-haiku-4-5'] }] }),
    );
    try {
      expect(runtime.llmPlanning).toBe(false);
    } finally {
      runtime.close();
    }
  });

  it('close() is safe when no db was opened, and after opening memory + journal', async () => {
    const a = await buildRuntime(await repo());
    expect(() => a.close()).not.toThrow(); // nothing opened

    const b = await buildRuntime(dir as string);
    b.memory();
    b.journal();
    expect(() => b.close()).not.toThrow();
  });
});
