import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdStatus } from './commands';
import { buildRuntime, type Runtime } from './runtime';

const POLICY = readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8');

let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A temp repo with the real policy (no config → defaults: profile safe). */
async function runtime(): Promise<Runtime> {
  dir = await mkdtemp(join(tmpdir(), 'archon-status-'));
  await mkdir(join(dir, '.archon'), { recursive: true });
  await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
  return buildRuntime(dir);
}

const captured = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
const text = (log: ReturnType<typeof captured>): string => log.mock.calls.flat().join('\n');

describe('archon status', () => {
  it('prints profile + budgets and an empty-journal hint, creating no db (human)', async () => {
    const rt = await runtime();
    const log = captured();
    await cmdStatus(rt);
    const out = text(log);

    expect(out).toContain('profile: safe');
    expect(out).toContain('journal: (empty');
    expect(existsSync(join(rt.root, '.archon/journal.db'))).toBe(false); // read-only intent
    rt.close();
  });

  it('emits a single valid JSON document with --json', async () => {
    const rt = await runtime();
    const log = captured();
    await cmdStatus(rt, { json: true });

    const report = JSON.parse(text(log)); // throws if not exactly one JSON document
    expect(report.profile).toBe('safe');
    expect(report.budgets).toEqual({ perTaskUsd: 2, globalDailyUsd: 25, contextTokensMax: 60_000 });
    expect(report.journal).toEqual([]);
    expect(existsSync(join(rt.root, '.archon/journal.db'))).toBe(false);
    rt.close();
  });
});
