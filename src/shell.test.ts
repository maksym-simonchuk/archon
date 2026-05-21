import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuntime, type Runtime } from './runtime';
import { completeShell, dispatch, loadHistory, saveHistory } from './shell';

const POLICY = readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8');

let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A runtime rooted at a temp repo (no providers → offline scaffolder). */
async function runtime(): Promise<Runtime> {
  dir = await mkdtemp(join(tmpdir(), 'archon-shell-'));
  await mkdir(join(dir, '.archon'), { recursive: true });
  await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
  return buildRuntime(dir);
}

const captured = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
const text = (log: ReturnType<typeof captured>): string => log.mock.calls.flat().join('\n');

describe('shell dispatch', () => {
  it('/help lists commands and keeps the REPL running', async () => {
    const rt = await runtime();
    const log = captured();
    try {
      expect(await dispatch(rt, '/help')).toBe(true);
      expect(text(log)).toContain('/plan <goal>');
    } finally {
      rt.close();
    }
  });

  it('/exit and /quit signal the REPL to stop', async () => {
    const rt = await runtime();
    try {
      expect(await dispatch(rt, '/exit')).toBe(false);
      expect(await dispatch(rt, '/quit')).toBe(false);
    } finally {
      rt.close();
    }
  });

  it('treats bare text as shorthand for /plan', async () => {
    const rt = await runtime();
    const log = captured();
    try {
      expect(await dispatch(rt, 'add a greeter')).toBe(true);
      const out = text(log);
      expect(out).toContain('planner: deterministic (scaffold)');
      expect(out).toContain('plan t-'); // a plan tree was rendered
    } finally {
      rt.close();
    }
  });

  it('reports an unknown slash command without throwing', async () => {
    const rt = await runtime();
    const log = captured();
    try {
      expect(await dispatch(rt, '/nope')).toBe(true);
      expect(text(log)).toContain('unknown command');
    } finally {
      rt.close();
    }
  });

  it('asks for a goal when /plan is given none', async () => {
    const rt = await runtime();
    const log = captured();
    try {
      expect(await dispatch(rt, '/plan')).toBe(true);
      expect(text(log)).toContain('usage: /plan <goal>');
    } finally {
      rt.close();
    }
  });
});

describe('shell tab-completion', () => {
  it('completes a slash-command prefix to its matches', () => {
    expect(completeShell('/pl')).toEqual([['/plan', '/plugins'], '/pl']);
    expect(completeShell('/s')).toEqual([['/status'], '/s']);
  });

  it('offers every command for a lone slash, and nothing for a bare goal', () => {
    expect(completeShell('/')[0]).toContain('/plan');
    expect(completeShell('/')[0]).toContain('/plugins');
    expect(completeShell('add a greeter')).toEqual([[], 'add a greeter']);
  });
});

describe('shell history persistence', () => {
  it('round-trips history (most-recent-first); a missing file reads empty', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-hist-'));
    const file = join(dir, 'shell_history');
    expect(loadHistory(file)).toEqual([]); // nothing persisted yet
    saveHistory(file, ['/status', 'add a greeter']); // index 0 = most recent
    expect(loadHistory(file)).toEqual(['/status', 'add a greeter']);
  });
});
