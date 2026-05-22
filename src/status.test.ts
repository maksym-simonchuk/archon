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

describe('archon status <taskId> (per-run replay)', () => {
  const TS = '2026-01-01T00:00:00Z';

  it("replays one task's entries in append order, unpacking each payload", async () => {
    const rt = await runtime();
    const j = rt.journal();
    j.append({ taskId: 't-1', ts: TS, kind: 'plan', payload: { rationale: 'do it', steps: ['add fn', 'test'] } });
    j.append({ taskId: 't-1', ts: TS, kind: 'diff', payload: { files: ['src/a.ts'], added: 5, removed: 1 } });
    j.append({ taskId: 't-1', ts: TS, kind: 'verdict', payload: { passed: false, checks: [{ name: 'tsc', passed: false }] } });
    j.append({ taskId: 't-2', ts: TS, kind: 'plan', payload: { rationale: 'OTHER TASK', steps: [] } }); // must not leak in

    const log = captured();
    await cmdStatus(rt, { taskId: 't-1' });
    const out = text(log);

    expect(out).toContain('task t-1: 3 entries');
    expect(out).toContain('steps: add fn · test'); // plan payload unpacked
    expect(out).toContain('src/a.ts (+5/-1)'); // diff payload unpacked
    expect(out).toContain('failed: tsc'); // verdict's failing check is named
    expect(out).not.toContain('OTHER TASK'); // scoped strictly to t-1
    rt.close();
  });

  it('reports an unknown task id without throwing', async () => {
    const rt = await runtime();
    rt.journal().append({ taskId: 't-1', ts: TS, kind: 'plan', payload: {} });
    const log = captured();
    await cmdStatus(rt, { taskId: 'ghost' });
    expect(text(log)).toContain('no journal entries');
    rt.close();
  });

  it('emits the replay as one JSON document with --json', async () => {
    const rt = await runtime();
    rt.journal().append({ taskId: 't-1', ts: TS, kind: 'cost', payload: { usd: 0.01 } });
    const log = captured();
    await cmdStatus(rt, { taskId: 't-1', json: true });

    const doc = JSON.parse(text(log)); // throws unless exactly one JSON document
    expect(doc.taskId).toBe('t-1');
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].kind).toBe('cost');
    rt.close();
  });
});
