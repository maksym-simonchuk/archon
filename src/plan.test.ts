import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTask, planContext } from './commands';
import { AuditLog } from './effecting/audit-log';
import { CapabilityBroker } from './effecting/capability-broker';
import { loadPolicy, PolicyEngine } from './effecting/policy-engine';
import type { Runtime } from './runtime';

const policyDoc = loadPolicy(readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8'));

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

// planContext touches `llmPlanning`, `root`, `brokerAt`, and `context`.
const fakeRt = (over: Partial<Runtime>): Runtime =>
  ({
    llmPlanning: true,
    context: async () => '# repo map\n',
    brokerAt: (cwd: string) => new CapabilityBroker(new PolicyEngine(policyDoc, 'safe'), new AuditLog(), cwd),
    ...over,
  }) as unknown as Runtime;

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
