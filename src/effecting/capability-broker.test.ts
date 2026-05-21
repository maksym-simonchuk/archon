import { readFileSync } from 'node:fs';
import { access, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BlastRadius } from '../core/types';
import { AuditLog } from './audit-log';
import { CapabilityBroker } from './capability-broker';
import { loadPolicy, PolicyEngine } from './policy-engine';

const doc = loadPolicy(readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8'));
const radius = (n: number): BlastRadius => ({
  files: Array.from({ length: n }, (_, i) => `f${i}.ts`),
  symbols: [],
  escapesRepo: false,
});
const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

let dir: string | undefined;
let outside: string | undefined;
afterEach(async () => {
  for (const d of [dir, outside]) if (d) await rm(d, { recursive: true, force: true });
  dir = outside = undefined;
});

function makeBroker(root: string): { broker: CapabilityBroker; audit: AuditLog } {
  const audit = new AuditLog();
  return { broker: new CapabilityBroker(new PolicyEngine(doc, 'safe'), audit, root), audit };
}

describe('CapabilityBroker (M3)', () => {
  it('records every decision in the append-only audit log', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-broker-'));
    const { broker, audit } = makeBroker(dir);
    await broker.request({ action: 'fs.read', target: 'src/x.ts', reason: 'inspect' });
    expect(audit.entries()).toHaveLength(1);
    expect(audit.entries()[0].kind).toBe('decision');
    expect(audit.entries()[0].seq).toBe(0);
  });

  it('writes on allow, but refuses (and does not write) on ask', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-broker-'));
    const { broker } = makeBroker(dir);

    const allowed = await broker.fsWrite('ok.ts', 'export const a = 1;\n', {
      blastRadius: radius(2),
      reason: 'small edit',
    });
    expect(allowed.ok).toBe(true);
    expect(await readFile(join(dir, 'ok.ts'), 'utf8')).toContain('export const a');

    const asked = await broker.fsWrite('big.ts', 'x', { blastRadius: radius(9), reason: 'wide edit' });
    expect(asked.ok).toBe(false);
    expect(await exists(join(dir, 'big.ts'))).toBe(false);
  });

  it('denies writes that escape the repo tree', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-broker-'));
    const { broker } = makeBroker(dir);
    const escaped = await broker.fsWrite('../evil.txt', 'pwn', { blastRadius: radius(1), reason: 'escape' });
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.error.message).toContain('escapes');
    expect(await exists(join(dir, '..', 'evil.txt'))).toBe(false);
  });

  it('denies writes that escape via an in-repo symlink (realpath, not lexical)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-broker-'));
    outside = await mkdtemp(join(tmpdir(), 'archon-outside-'));
    const { broker } = makeBroker(dir);

    // A symlinked directory inside the repo that points outside it. A lexical
    // resolve + prefix check is fooled — the path string stays under the repo;
    // only following the symlink (realpath) reveals the escape.
    await symlink(outside, join(dir, 'link'), 'dir');
    const escaped = await broker.fsWrite('link/evil.txt', 'pwn', { blastRadius: radius(1), reason: 'symlink escape' });
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.error.message).toContain('escapes');
    expect(await exists(join(outside, 'evil.txt'))).toBe(false);
  });
});
