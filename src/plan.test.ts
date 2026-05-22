import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask, planContext } from './commands';
import { AuditLog } from './effecting/audit-log';
import { CapabilityBroker } from './effecting/capability-broker';
import { loadPolicy, PolicyEngine } from './effecting/policy-engine';
import type { Plugin } from './plugins/abi';
import type { Runtime } from './runtime';
import { PluginHost } from './services/plugin-host';

const policyDoc = loadPolicy(readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8'));

let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

// planContext touches `llmPlanning`, `root`, `brokerAt`, `context`, and (for --skill) `pluginHost`.
const fakeRt = (over: Partial<Runtime>): Runtime =>
  ({
    llmPlanning: true,
    context: async () => '# repo map\n',
    brokerAt: (cwd: string) => new CapabilityBroker(new PolicyEngine(policyDoc, 'safe'), new AuditLog(), cwd),
    ...over,
  }) as unknown as Runtime;

const skill = (name: string, playbook: string): Plugin => ({
  kind: 'skill',
  manifest: { name, version: '1.0.0', kind: 'skill', capabilities: [] },
  playbook,
});

/** A host pre-loaded with `plugins`, sharing the test's policy via a real broker. */
const hostWith = (...plugins: Plugin[]): PluginHost => {
  const host = new PluginHost(new CapabilityBroker(new PolicyEngine(policyDoc, 'safe'), new AuditLog(), process.cwd()));
  for (const p of plugins) host.register(p);
  return host;
};

describe('planContext (@file in /plan and /run)', () => {
  it('prepends @file contents (read via the broker) ahead of the repo-map context', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-plan-'));
    await writeFile(join(dir, 'spec.md'), 'SPEC BODY');
    const rt = fakeRt({ root: dir });

    const out = await planContext(rt, makeTask('implement @spec.md', 'safe'), 'implement @spec.md');

    expect(out).toContain('SPEC BODY');
    expect(out).toContain('# repo map');
    expect(out.indexOf('SPEC BODY')).toBeLessThan(out.indexOf('# repo map')); // attachments come first
  });

  it('never reads files for the offline scaffolder (no LLM → context unchanged)', async () => {
    const rt = fakeRt({
      llmPlanning: false,
      root: '/unused',
      brokerAt: () => {
        throw new Error('scaffolder must not read @files');
      },
    });

    const out = await planContext(rt, makeTask('inspect @anything', 'safe'), 'inspect @anything');

    expect(out).toBe('# repo map\n'); // just rt.context(), no attachments
  });
});

describe('planContext (--skill playbook injection)', () => {
  it('prepends the selected skill playbook ahead of the repo-map context', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const rt = fakeRt({ pluginHost: async () => hostWith(skill('refactor', 'STEP 1: extract\nSTEP 2: test')) });

    const out = await planContext(rt, makeTask('clean up', 'safe'), 'clean up', 'refactor');

    expect(out).toContain('# Skill: refactor');
    expect(out).toContain('STEP 1: extract'); // the whole playbook is folded in
    expect(out.indexOf('# Skill: refactor')).toBeLessThan(out.indexOf('# repo map')); // playbook leads
    expect(log).toHaveBeenCalledWith('  + applying skill "refactor"');
  });

  it('plans without a skill (and says so) when the named one is not loaded', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const rt = fakeRt({ pluginHost: async () => hostWith() }); // no skills registered

    const out = await planContext(rt, makeTask('clean up', 'safe'), 'clean up', 'ghost');

    expect(out).toBe('# repo map\n'); // unchanged — no playbook prepended
    expect(log.mock.calls.flat().join('\n')).toContain('skill "ghost" not loaded');
  });

  it('ignores a skill request under the offline scaffolder (context untouched)', async () => {
    const rt = fakeRt({
      llmPlanning: false,
      pluginHost: async () => {
        throw new Error('scaffolder must not resolve skills');
      },
    });

    const out = await planContext(rt, makeTask('clean up', 'safe'), 'clean up', 'refactor');

    expect(out).toBe('# repo map\n'); // skill resolution skipped entirely
  });
});
