import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdPromote, cmdPromotions, extractFlag } from './commands';
import { buildRuntime, type Runtime } from './runtime';

const POLICY = readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8');

let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function runtime(): Promise<Runtime> {
  dir = await mkdtemp(join(tmpdir(), 'archon-cmd-'));
  await mkdir(join(dir, '.archon'), { recursive: true });
  await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
  return buildRuntime(dir);
}

const captured = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
const text = (log: ReturnType<typeof captured>): string => log.mock.calls.flat().join('\n');

describe('memory promotion commands (M5 human gate)', () => {
  it('lists a qualifying candidate, then promotes it only on confirmation', async () => {
    const rt = await runtime();
    const mem = rt.memory();
    mem.write({
      id: 'episode:e1',
      tier: 'episodic',
      key: 'add a thing',
      content: 'ran',
      createdAt: new Date().toISOString(),
    });
    // Meet the bar: freq ≥ 3 (each recall bumps freq) and success ≥ 2.
    mem.recall('episodic', 'add a thing');
    mem.recall('episodic', 'add a thing');
    mem.recall('episodic', 'add a thing');
    mem.recordSuccess('episode:e1');
    mem.recordSuccess('episode:e1');

    const log = captured();
    await cmdPromotions(rt);
    expect(text(log)).toContain('episode:e1');

    log.mockClear();
    await cmdPromote(rt, 'episode:e1');
    expect(text(log)).toContain('promoted episode:e1 → semantic');

    log.mockClear();
    await cmdPromote(rt, 'nope');
    expect(text(log)).toContain('not promotable');

    rt.close();
  });

  it('reports an empty store without creating the db', async () => {
    const rt = await runtime();
    const log = captured();
    await cmdPromotions(rt); // never opened memory()
    expect(text(log)).toContain('empty (no runs yet)');
    rt.close();
  });
});

describe('extractFlag (shared --skill parsing for plan/run)', () => {
  it('lifts a flag value out of the token stream, leaving the goal intact', () => {
    expect(extractFlag(['--skill', 'refactor', 'add', 'a', 'widget'], '--skill')).toEqual({
      value: 'refactor',
      rest: ['add', 'a', 'widget'],
    });
    // a flag in the middle is spliced out cleanly, value and all
    expect(extractFlag(['fix', '--skill', 'debug', 'the', 'bug'], '--skill')).toEqual({
      value: 'debug',
      rest: ['fix', 'the', 'bug'],
    });
  });

  it('returns the tokens unchanged when the flag is absent', () => {
    expect(extractFlag(['add', 'a', 'widget'], '--skill')).toEqual({ rest: ['add', 'a', 'widget'] });
  });

  it('drops a dangling flag that has no following value', () => {
    expect(extractFlag(['add', 'a', 'widget', '--skill'], '--skill')).toEqual({ rest: ['add', 'a', 'widget'] });
  });
});
