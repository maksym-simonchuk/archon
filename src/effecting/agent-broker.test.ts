import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityAction } from '../core/types';
import { AgentBroker } from './agent-broker';
import { AuditLog } from './audit-log';
import { loadPolicy, PolicyEngine } from './policy-engine';

// A trusted profile so policy itself allows fs.read/fs.write/exec — the AgentBroker
// is what narrows authority down to the agent's declared capabilities on top.
const POLICY = loadPolicy(`
active_profile: trusted
profiles:
  trusted:
    allow:
      - { action: "fs.read", target: "**" }
      - { action: "fs.write", target: "**" }
      - { action: "exec" }
`);

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const brokerWith = async (allowed: CapabilityAction[]): Promise<AgentBroker> => {
  dir = await mkdtemp(join(tmpdir(), 'archon-agent-broker-'));
  return new AgentBroker(new PolicyEngine(POLICY, 'trusted'), new AuditLog(), dir, allowed);
};

describe('AgentBroker', () => {
  it('denies a capability the agent did not declare, before policy', async () => {
    const broker = await brokerWith(['fs.read']);
    const verdict = await broker.request({ action: 'fs.write', target: 'a.ts', reason: 'test' });
    expect(verdict.decision).toBe('deny');
    expect(verdict.rule).toBe('agent.capability_denied');
  });

  it('blocks a write for a read-only agent — nothing reaches disk', async () => {
    const broker = await brokerWith(['fs.read']);
    const res = await broker.fsWrite('a.ts', 'export const a = 1;', { reason: 'test' });
    expect(res.ok).toBe(false);
    await expect(readFile(join(dir as string, 'a.ts'), 'utf8')).rejects.toThrow();
  });

  it('passes through a declared capability to the real broker (write lands)', async () => {
    const broker = await brokerWith(['fs.read', 'fs.write']);
    const res = await broker.fsWrite('a.ts', 'export const a = 1;', { reason: 'test' });
    expect(res.ok).toBe(true);
    expect(await readFile(join(dir as string, 'a.ts'), 'utf8')).toBe('export const a = 1;');
  });

  it('blocks exec for an agent granted only fs capabilities', async () => {
    const broker = await brokerWith(['fs.read', 'fs.write']);
    const res = await broker.exec(['echo', 'hi'], { reason: 'test' });
    expect(res.ok).toBe(false);
  });
});
