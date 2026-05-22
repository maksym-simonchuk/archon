import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdMemoryList } from './commands';
import type { MemoryRecord } from './core/types';
import { buildRuntime, type Runtime } from './runtime';

const POLICY = readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8');

let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function runtime(): Promise<Runtime> {
  dir = await mkdtemp(join(tmpdir(), 'archon-memlist-'));
  await mkdir(join(dir, '.archon'), { recursive: true });
  await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
  return buildRuntime(dir);
}

const rec = (id: string, tier: MemoryRecord['tier'], key: string, content: string, confirmed = false): MemoryRecord => ({
  id,
  tier,
  key,
  content,
  createdAt: new Date().toISOString(),
  confirmed,
});

const captured = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
const text = (log: ReturnType<typeof captured>): string => log.mock.calls.flat().join('\n');

describe('archon memory list (memory observability)', () => {
  it('lists stored records across tiers, flagging confirmed ones', async () => {
    const rt = await runtime();
    const mem = rt.memory(); // first call creates the db
    mem.write(rec('m1', 'episodic', 'task:foo', 'ran the foo task'));
    mem.write(rec('m2', 'semantic', 'adr:0003', 'capability broker mediates effects', true));

    const log = captured();
    await cmdMemoryList(rt);
    const out = text(log);

    expect(out).toContain('task:foo');
    expect(out).toContain('adr:0003');
    expect(out).toContain('✓confirmed'); // m2 is confirmed
    rt.close();
  });

  it('narrows to a single tier', async () => {
    const rt = await runtime();
    const mem = rt.memory();
    mem.write(rec('m1', 'episodic', 'task:foo', 'ran foo'));
    mem.write(rec('m2', 'semantic', 'adr:0003', 'broker'));

    const log = captured();
    await cmdMemoryList(rt, 'semantic');
    const out = text(log);

    expect(out).toContain('in semantic');
    expect(out).toContain('adr:0003');
    expect(out).not.toContain('task:foo'); // episodic record excluded
    rt.close();
  });

  it('rejects an unknown tier', async () => {
    const rt = await runtime();
    rt.memory().write(rec('m1', 'episodic', 'task:foo', 'ran foo'));
    const log = captured();
    await cmdMemoryList(rt, 'nonsense');
    expect(text(log)).toContain('unknown tier "nonsense"');
    rt.close();
  });

  it('reports an empty memory plane when no db exists yet', async () => {
    const rt = await runtime();
    const log = captured();
    await cmdMemoryList(rt); // never opened the store
    expect(text(log)).toContain('empty (no runs yet)');
    rt.close();
  });
});
