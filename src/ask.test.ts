import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AskTurn, cmdAsk, extractFileRefs } from './commands';
import type { ModelSpec } from './core/types';
import { AuditLog } from './effecting/audit-log';
import { CapabilityBroker } from './effecting/capability-broker';
import { loadPolicy, PolicyEngine } from './effecting/policy-engine';
import type { Runtime } from './runtime';
import { ProviderRouter, type ProviderClient } from './services/provider-router';

const policyDoc = loadPolicy(readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8'));

let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const model: ModelSpec = {
  id: 'm',
  provider: 'fake',
  contextWindow: 1000,
  costPer1kInput: 0,
  costPer1kOutput: 0,
  strengths: ['summarize'],
};

// Records the prompt it was handed and streams a fixed two-chunk answer. The
// non-streaming methods are required by the contract but unused on /ask — they
// reject so a wrong route is caught loudly.
function streamingClient(): { client: ProviderClient; lastPrompt: () => string } {
  let seen = '';
  const client: ProviderClient = {
    provider: 'fake',
    complete: () => Promise.reject(new Error('unused on /ask path')),
    completeObject: () => Promise.reject(new Error('unused on /ask path')),
    completeStream: (_m, prompt) => {
      seen = prompt;
      async function* gen(): AsyncGenerator<string> {
        yield 'hel';
        yield 'lo';
      }
      return { textStream: gen(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) };
    },
  };
  return { client, lastPrompt: () => seen };
}

// cmdAsk reads `llmPlanning` + `router` (and, when the question has @refs,
// `brokerAt` + `root`); build the smallest shape that satisfies it.
const fakeRt = (llmPlanning: boolean, router: ProviderRouter): Runtime =>
  ({ llmPlanning, router }) as unknown as Runtime;
const brokerRt = (router: ProviderRouter, root: string): Runtime =>
  ({
    llmPlanning: true,
    router,
    root,
    brokerAt: (cwd: string) => new CapabilityBroker(new PolicyEngine(policyDoc, 'safe'), new AuditLog(), cwd),
  }) as unknown as Runtime;
const muteStdout = () =>
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);

describe('cmdAsk (streaming /ask)', () => {
  it('streams to stdout, returns the full text, and prints the model footer', async () => {
    const write = muteStdout();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { client } = streamingClient();
    const router = new ProviderRouter([model], [client]);

    const answer = await cmdAsk(fakeRt(true, router), 'what is this repo?');

    expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain('hello');
    expect(answer).toBe('hello'); // returned so the shell can thread it into the transcript
    expect(log.mock.calls.flat().join('\n')).toContain('— m'); // model attribution footer
  });

  it('weaves prior turns into the prompt so the conversation carries context', async () => {
    muteStdout();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { client, lastPrompt } = streamingClient();
    const router = new ProviderRouter([model], [client]);
    const history: AskTurn[] = [{ question: 'what stack?', answer: 'TypeScript + Rust/WASM' }];

    await cmdAsk(fakeRt(true, router), 'and the package manager?', history);

    expect(lastPrompt()).toContain('what stack?');
    expect(lastPrompt()).toContain('TypeScript + Rust/WASM');
    expect(lastPrompt()).toContain('and the package manager?');
  });

  it('short-circuits with guidance (and returns empty) when no LLM provider is configured', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const router = new ProviderRouter([], []);

    const answer = await cmdAsk(fakeRt(false, router), 'hi');

    expect(answer).toBe('');
    expect(log.mock.calls.flat().join('\n')).toContain('no LLM provider configured');
  });

  it('keeps the partial answer and footers it cancelled when the stream is aborted', async () => {
    const write = muteStdout();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const controller = new AbortController();
    const client: ProviderClient = {
      provider: 'fake',
      complete: () => Promise.reject(new Error('unused on /ask path')),
      completeObject: () => Promise.reject(new Error('unused on /ask path')),
      completeStream: (_m, _p, _mt, signal) => {
        async function* gen(): AsyncGenerator<string> {
          yield 'par';
          controller.abort(); // user hits Ctrl-C mid-stream
          if (signal?.aborted) return;
          yield 'tial';
        }
        return { textStream: gen(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) };
      },
    };
    const router = new ProviderRouter([model], [client]);

    const answer = await cmdAsk(fakeRt(true, router), 'explain', [], controller.signal);

    expect(answer).toBe('par'); // the partial answer is preserved, not discarded
    expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain('par');
    expect(log.mock.calls.flat().join('\n')).toContain('(cancelled)'); // footered as cancelled, no cost
  });
});

describe('extractFileRefs', () => {
  it('pulls @path tokens, deduped and order-preserving', () => {
    expect(extractFileRefs('explain @src/a.ts and @src/b.ts')).toEqual(['src/a.ts', 'src/b.ts']);
    expect(extractFileRefs('@x then @x again')).toEqual(['x']); // deduped
  });

  it('ignores a non-boundary @ (so emails are not refs) and trims trailing punctuation', () => {
    expect(extractFileRefs('mail me at user@host.com')).toEqual([]);
    expect(extractFileRefs('see @src/x.ts, and @src/y.ts.')).toEqual(['src/x.ts', 'src/y.ts']);
  });
});

describe('cmdAsk @file context', () => {
  it('reads an @file through the broker and injects its contents into the prompt', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-ask-'));
    await writeFile(join(dir, 'note.txt'), 'the answer is 42');
    muteStdout();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { client, lastPrompt } = streamingClient();

    await cmdAsk(brokerRt(new ProviderRouter([model], [client]), dir), 'what does @note.txt say?');

    expect(lastPrompt()).toContain('Attached files:');
    expect(lastPrompt()).toContain('the answer is 42');
  });

  it('refuses an @secret file: contents never reach the prompt, the user is told', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-ask-'));
    await writeFile(join(dir, '.env'), 'OPENAI_API_KEY=sk-do-not-leak');
    muteStdout();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { client, lastPrompt } = streamingClient();

    await cmdAsk(brokerRt(new ProviderRouter([model], [client]), dir), 'print @.env');

    expect(lastPrompt()).not.toContain('sk-do-not-leak'); // the secret is never sent to the model
    expect(lastPrompt()).toContain('unavailable');
    expect(log.mock.calls.flat().join('\n')).toContain('skipped @.env');
  });
});
