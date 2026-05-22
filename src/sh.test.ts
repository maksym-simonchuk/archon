import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdSh } from './commands';
import { AuditLog } from './effecting/audit-log';
import { CapabilityBroker } from './effecting/capability-broker';
import { loadPolicy, PolicyEngine } from './effecting/policy-engine';
import type { Runtime } from './runtime';

const policyDoc = loadPolicy(readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8'));

afterEach(() => vi.restoreAllMocks());

// cmdSh only needs brokerAt + root; the broker enforces the real safe policy.
const rt = (): Runtime =>
  ({
    root: process.cwd(),
    brokerAt: (cwd: string) => new CapabilityBroker(new PolicyEngine(policyDoc, 'safe'), new AuditLog(), cwd),
  }) as unknown as Runtime;

describe('cmdSh (broker-gated command passthrough)', () => {
  it('runs an allowed command and writes its stdout', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await cmdSh(rt(), 'node --version'); // `node` is on the safe allow-list; --version is read-only
    expect(out.mock.calls.flat().join('')).toMatch(/v\d+\./); // the real version string came back
  });

  it('denies a destructive command — the policy blocks it before it can run', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await cmdSh(rt(), 'rm -rf /tmp/whatever'); // `rm -rf` is a hard deny (subsequence match)
    expect(err.mock.calls.flat().join('\n')).toContain('policy.deny');
  });

  it('refuses an ask-class command (git checkout) without running it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await cmdSh(rt(), 'git checkout main'); // `ask` is not `allow`, so exec is refused
    expect(err.mock.calls.flat().join('\n')).toContain('policy.ask');
  });

  it('prints usage for an empty command (no argv)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await cmdSh(rt(), '   ');
    expect(log.mock.calls.flat().join('\n')).toContain('usage: /sh');
  });
});
