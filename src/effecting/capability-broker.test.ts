import { readFileSync } from 'node:fs';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

  it('reads a normal file on allow', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-broker-'));
    const { broker } = makeBroker(dir);
    await writeFile(join(dir, 'note.txt'), 'hello from disk\n');

    const read = await broker.fsRead('note.txt', { reason: 'inspect' });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toContain('hello from disk');
  });

  it('denies reading a secret file and never returns its contents (policy enforced, not just declared)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-broker-'));
    const { broker } = makeBroker(dir);
    await writeFile(join(dir, '.env'), 'OPENAI_API_KEY=sk-do-not-leak\n');

    const read = await broker.fsRead('.env', { reason: 'exfil attempt' });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error.code).toBe('policy.deny');
      expect(read.error.message ?? '').not.toContain('sk-do-not-leak'); // the secret never surfaces
    }
  });

  it('denies reads that escape the repo tree', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-broker-'));
    const { broker } = makeBroker(dir);
    const escaped = await broker.fsRead('../secret.txt', { reason: 'escape' });
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.error.message).toContain('escapes');
  });

  it('returns a benign fs.read_failed (not a throw) for a missing file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-broker-'));
    const { broker } = makeBroker(dir);
    const read = await broker.fsRead('nope.txt', { reason: 'typo' });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe('fs.read_failed');
  });

  it('asks (refuses, no rm) when fs.delete is requested under the safe profile', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-broker-'));
    const { broker } = makeBroker(dir);
    await writeFile(join(dir, 'doomed.ts'), 'x');
    const result = await broker.fsDelete('doomed.ts', { reason: 'remove a stale artifact' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('policy.ask');
    expect(await exists(join(dir, 'doomed.ts'))).toBe(true);
  });

  it('denies fs.delete that would escape the repo tree', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-broker-'));
    const { broker } = makeBroker(dir);
    const escaped = await broker.fsDelete('../outside.ts', { reason: 'escape attempt' });
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.error.message).toContain('escapes');
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
