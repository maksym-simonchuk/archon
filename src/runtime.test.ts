import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from './core/types';
import { MemoryStore } from './memory/store';
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

  it('assembles no context for the offline scaffolder (avoids loading index/WASM)', async () => {
    const runtime = await buildRuntime(await repo());
    try {
      expect(runtime.llmPlanning).toBe(false);
      expect(await runtime.context(task)).toBe('');
    } finally {
      runtime.close();
    }
  });

  it('activates the LLM planner when a provider is configured and its key is present', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const runtime = await buildRuntime(
      await repo({ providers: [{ id: 'anthropic', models: ['claude-haiku-4-5-20251001'] }] }),
    );
    try {
      expect(runtime.llmPlanning).toBe(true);
      expect(runtime.router.spent).toBe(0); // nothing charged just by wiring
    } finally {
      runtime.close();
    }
  });

  it('folds prior-run memory into the LLM context via the bundled retriever', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const root = await repo({ providers: [{ id: 'anthropic', models: ['claude-haiku-4-5-20251001'] }] });
    const mem = new MemoryStore(join(root, '.archon/memory.db'));
    mem.write({
      id: 'episode:prev',
      tier: 'episodic',
      key: task.goal,
      content: 'prior run of add a widget: passed=false',
      createdAt: '2026-01-01T00:00:00Z',
    });
    mem.close();

    const runtime = await buildRuntime(root);
    try {
      const ctx = await runtime.context(task);
      expect(ctx).toContain('Relevant prior runs');
      expect(ctx).toContain('passed=false');
    } finally {
      runtime.close();
    }
  });

  it('recalls pinned ADRs whose text the goal names into the LLM context (M16→M17)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const root = await repo({ providers: [{ id: 'anthropic', models: ['claude-haiku-4-5-20251001'] }] });
    const mem = new MemoryStore(join(root, '.archon/memory.db'));
    mem.write(
      {
        id: 'adr:0007',
        tier: 'semantic',
        key: 'Auth via session tokens',
        content: 'ADR-0007 [accepted] Auth via session tokens\nwhy: stateless edge',
        createdAt: '2026-01-01T00:00:00Z',
        confirmed: true,
      },
      { pinned: true },
    );
    mem.close();

    const authTask: Task = { ...task, goal: 'change the auth flow' };
    const runtime = await buildRuntime(root);
    try {
      const ctx = await runtime.context(authTask);
      expect(ctx).toContain('Relevant decisions');
      expect(ctx).toContain('ADR-0007 [accepted] Auth via session tokens');
      // A goal that names nothing in the ADR pulls no decisions in.
      expect(await runtime.context(task)).not.toContain('Relevant decisions');
    } finally {
      runtime.close();
    }
  });

  it('folds retriever-plugin hits into the LLM context', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const root = await repo({ providers: [{ id: 'anthropic', models: ['claude-haiku-4-5-20251001'] }] });
    await mkdir(join(root, '.archon/plugins/marker'), { recursive: true });
    await writeFile(
      join(root, '.archon/plugins/marker/plugin.mjs'),
      "export const plugin = { kind: 'retriever', manifest: { name: 'marker', version: '0', kind: 'retriever', capabilities: [] }, retrieve: async (q) => ['MARKER_HIT for ' + q] };\n",
    );

    const runtime = await buildRuntime(root);
    try {
      const ctx = await runtime.context(task);
      expect(ctx).toContain('Plugin retrievers');
      expect(ctx).toContain('MARKER_HIT for add a widget');
    } finally {
      runtime.close();
    }
  });

  it('degrades to the scaffolder when the provider key is absent', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const runtime = await buildRuntime(
      await repo({ providers: [{ id: 'anthropic', models: ['claude-haiku-4-5-20251001'] }] }),
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
