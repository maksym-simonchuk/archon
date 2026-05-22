import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelSpec } from './core/types';
import { buildRuntime, type Runtime } from './runtime';
import { ProviderRouter, type ProviderClient } from './services/provider-router';
import { completeShell, dispatch, loadHistory, newSession, saveHistory, suggestLine } from './shell';

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
      expect(text(log)).toContain('/plan [--skill <name>] <goal>');
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

  it('/cost reports session spend against the per-task budget', async () => {
    const rt = await runtime();
    const log = captured();
    try {
      expect(await dispatch(rt, '/cost')).toBe(true);
      const out = text(log);
      expect(out).toContain('cost: $0.0000 this session'); // fresh session, nothing spent
      expect(out).toContain('task budget 0% used');
    } finally {
      rt.close();
    }
  });

  it('/recap reports no runs before anything is journaled', async () => {
    const rt = await runtime();
    const log = captured();
    try {
      expect(await dispatch(rt, '/recap')).toBe(true);
      expect(text(log)).toContain('no runs journaled yet');
    } finally {
      rt.close();
    }
  });

  it('/boundaries reports no index before one is built', async () => {
    const rt = await runtime();
    const log = captured();
    try {
      expect(await dispatch(rt, '/boundaries')).toBe(true);
      expect(text(log)).toContain('no index yet');
    } finally {
      rt.close();
    }
  });

  it('/violations reports no index before one is built', async () => {
    const rt = await runtime();
    const log = captured();
    try {
      expect(await dispatch(rt, '/violations')).toBe(true);
      expect(text(log)).toContain('no index yet');
    } finally {
      rt.close();
    }
  });

  it('/evolution reports no index before one is built', async () => {
    const rt = await runtime();
    const log = captured();
    try {
      expect(await dispatch(rt, '/evolution')).toBe(true);
      expect(text(log)).toContain('no index yet');
    } finally {
      rt.close();
    }
  });

  it('/decisions reports when the repo has no ADRs', async () => {
    const rt = await runtime();
    const log = captured();
    try {
      expect(await dispatch(rt, '/decisions')).toBe(true);
      expect(text(log)).toContain('no ADRs found');
    } finally {
      rt.close();
    }
  });

  it('/watch runs a tick without a git repo and stays quiet', async () => {
    const rt = await runtime();
    const log = captured();
    const session = newSession();
    try {
      expect(await dispatch(rt, '/watch', session)).toBe(true);
      expect(text(log)).toBe(''); // no dirty paths → quiet tick, nothing printed
      expect(session.watchDirty.size).toBe(0);
    } finally {
      rt.close();
    }
  });

  it('/watch reindexes the dirty subtree and reports health', async () => {
    const { simpleGit } = await import('simple-git');
    const rt = await runtime();
    const git = simpleGit(rt.root);
    await git.init();
    await writeFile(join(rt.root, 'a.ts'), 'export const a = 1;\n');
    const log = captured();
    const session = newSession();
    try {
      expect(await dispatch(rt, '/watch', session)).toBe(true);
      const out = text(log);
      expect(out).toContain('watch:');
      expect(out).toContain('health');
      expect(session.watchDirty.has('a.ts')).toBe(true);
    } finally {
      rt.close();
    }
  });

  it('/refactor reports no index before one is built', async () => {
    const rt = await runtime();
    const log = captured();
    try {
      expect(await dispatch(rt, '/refactor')).toBe(true);
      expect(text(log)).toContain('no index yet');
    } finally {
      rt.close();
    }
  });

  it('/refactor rejects a bad --pick value', async () => {
    const rt = await runtime();
    const log = captured();
    try {
      expect(await dispatch(rt, '/refactor --pick -1')).toBe(true);
      expect(text(log)).toContain('usage: /refactor');
    } finally {
      rt.close();
    }
  });

  it('/agent asks for a goal when given none', async () => {
    const rt = await runtime();
    const log = captured();
    try {
      expect(await dispatch(rt, '/agent')).toBe(true);
      expect(text(log)).toContain('usage: /agent [--run] <goal>');
    } finally {
      rt.close();
    }
  });

  it('/agent reports no index before one is built', async () => {
    const rt = await runtime();
    const log = captured();
    try {
      expect(await dispatch(rt, '/agent fix the routing')).toBe(true);
      expect(text(log)).toContain('no index yet');
    } finally {
      rt.close();
    }
  });

  it('/risk asks for a file when given none', async () => {
    const rt = await runtime();
    const log = captured();
    try {
      expect(await dispatch(rt, '/risk')).toBe(true);
      expect(text(log)).toContain('usage: /risk <file>');
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
      expect(text(log)).toContain('usage: /plan [--skill <name>] <goal>');
    } finally {
      rt.close();
    }
  });
});

describe('shell conversational /ask', () => {
  const model: ModelSpec = {
    id: 'm',
    provider: 'fake',
    contextWindow: 1000,
    costPer1kInput: 0,
    costPer1kOutput: 0,
    strengths: ['summarize'],
  };
  const askClient: ProviderClient = {
    provider: 'fake',
    complete: () => Promise.reject(new Error('unused on /ask path')),
    completeObject: () => Promise.reject(new Error('unused on /ask path')),
    completeStream: () => {
      async function* gen(): AsyncGenerator<string> {
        yield 'ok';
      }
      return { textStream: gen(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) };
    },
  };
  // dispatch only touches `llmPlanning` + `router` on the /ask path.
  const streamingRt = (router: ProviderRouter): Runtime => ({ llmPlanning: true, router }) as unknown as Runtime;

  it('accumulates /ask turns in the session and /clear resets them', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const log = captured();
    const rt = streamingRt(new ProviderRouter([model], [askClient]));
    const session = newSession();

    await dispatch(rt, '/ask what stack?', session);
    await dispatch(rt, '/ask and the PM?', session);
    expect(session.askHistory).toHaveLength(2);
    expect(session.askHistory[0]).toEqual({ question: 'what stack?', answer: 'ok' });

    expect(await dispatch(rt, '/clear', session)).toBe(true);
    expect(session.askHistory).toHaveLength(0);
    expect(text(log)).toContain('context cleared');
  });
});

describe('shell tab-completion', () => {
  it('completes a slash-command prefix to its matches', () => {
    expect(completeShell('/pl')).toEqual([['/plan', '/plugins'], '/pl']);
    expect(completeShell('/s')).toEqual([['/simulate', '/status', '/skills', '/sh'], '/s']);
    expect(completeShell('/sk')).toEqual([['/skills'], '/sk']);
    expect(completeShell('/sh')).toEqual([['/sh'], '/sh']);
  });

  it('offers every command for a lone slash, and nothing for a bare goal', () => {
    expect(completeShell('/')[0]).toContain('/plan');
    expect(completeShell('/')[0]).toContain('/plugins');
    expect(completeShell('add a greeter')).toEqual([[], 'add a greeter']);
  });

  it('completes static subcommands and their values', () => {
    expect(completeShell('/memory ')).toEqual([['/memory list', '/memory graph'], '/memory ']);
    expect(completeShell('/policy c')).toEqual([['/policy check'], '/policy c']);
    expect(completeShell('/decisions ')).toEqual([['/decisions propose'], '/decisions ']);
    expect(completeShell('/watch ')).toEqual([['/watch --loop', '/watch --stop'], '/watch ']);
    expect(completeShell('/memory list ')[0]).toEqual([
      '/memory list episodic',
      '/memory list semantic',
      '/memory list procedural',
    ]);
    expect(completeShell('/memory list se')).toEqual([['/memory list semantic'], '/memory list se']);
  });

  it('offers nothing for an unknown command or a command without static args', () => {
    expect(completeShell('/run some goal')).toEqual([[], '/run some goal']);
    expect(completeShell('/bogus ar')).toEqual([[], '/bogus ar']);
  });
});

describe('shell ghost-text autosuggest', () => {
  const history = ['/run add a greeter', '/plan fix bug', '/status'];

  it('prefers the most-recent matching history entry', () => {
    expect(suggestLine('/run a', history)).toBe('/run add a greeter');
    expect(suggestLine('/pl', history)).toBe('/plan fix bug'); // history beats the /plan command
  });

  it('falls back to a command name when no history matches', () => {
    expect(suggestLine('/mo', history)).toBe('/model');
  });

  it('suggests nothing for an empty line, an exact match, or no match', () => {
    expect(suggestLine('', history)).toBeUndefined();
    expect(suggestLine('/status', history)).toBeUndefined(); // equal length is not an extension
    expect(suggestLine('/zzz', history)).toBeUndefined();
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
