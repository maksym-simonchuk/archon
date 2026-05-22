import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdPolicy } from './commands';
import { buildRuntime, type Runtime } from './runtime';

const POLICY = readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8');

let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

// A runtime over the real policy.yaml (no archon.config.json → default `safe` profile).
async function runtime(): Promise<Runtime> {
  dir = await mkdtemp(join(tmpdir(), 'archon-policy-'));
  await mkdir(join(dir, '.archon'), { recursive: true });
  await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
  return buildRuntime(dir);
}

const captured = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
const text = (log: ReturnType<typeof captured>): string => log.mock.calls.flat().join('\n');

describe('archon policy (constraint introspection)', () => {
  it('lists the active profile and its rules with no argument', async () => {
    const rt = await runtime();
    const log = captured();
    await cmdPolicy(rt);
    const out = text(log);

    expect(out).toContain('profile "safe"');
    expect(out).toContain('allow'); // some capability is granted
    expect(out).toContain('deny'); // destructive actions are denied
    expect(out).toContain('deny > ask > allow'); // the precedence note
    rt.close();
  });

  it('dry-runs an allowed command without executing it', async () => {
    const rt = await runtime();
    const log = captured();
    await cmdPolicy(rt, { check: 'node --version' }); // on the safe allow-list
    const out = text(log);
    expect(out).toContain('✓ allow: node --version');
    expect(out).toContain('rule:');
    rt.close();
  });

  it('reports a denied command and the rule that fired', async () => {
    const rt = await runtime();
    const log = captured();
    await cmdPolicy(rt, { check: 'rm -rf /tmp/x' }); // hard deny
    const out = text(log);
    expect(out).toContain('✗ deny: rm -rf /tmp/x');
    expect(out).toContain('rule:');
    rt.close();
  });

  it('reports an ask-class command (not allowed, not run)', async () => {
    const rt = await runtime();
    const log = captured();
    await cmdPolicy(rt, { check: 'git checkout main' });
    expect(text(log)).toContain('? ask: git checkout main');
    rt.close();
  });

  it('prints usage for an empty check', async () => {
    const rt = await runtime();
    const log = captured();
    await cmdPolicy(rt, { check: '   ' });
    expect(text(log)).toContain('usage: policy check');
    rt.close();
  });

  it('emits the verdict as JSON for a programmatic permission gate', async () => {
    const rt = await runtime();
    const log = captured();
    await cmdPolicy(rt, { check: 'rm -rf /tmp/x', json: true });
    const verdict = JSON.parse(text(log)); // stdout is exactly one JSON document

    expect(verdict.decision).toBe('deny');
    expect(typeof verdict.rule).toBe('string');
    expect(typeof verdict.message).toBe('string');
    rt.close();
  });

  it('emits the active profile and rules as JSON with no argument', async () => {
    const rt = await runtime();
    const log = captured();
    await cmdPolicy(rt, { json: true });
    const report = JSON.parse(text(log));

    expect(report.profile).toBe('safe');
    expect(Array.isArray(report.chain)).toBe(true);
    expect(report.rules.some((r: { decision: string }) => r.decision === 'deny')).toBe(true);
    rt.close();
  });
});
