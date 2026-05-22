import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AskTurn, cmdAsk } from './commands';
import type { ModelSpec } from './core/types';
import type { Runtime } from './runtime';
import { ProviderRouter, type ProviderClient } from './services/provider-router';

afterEach(() => vi.restoreAllMocks());

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

// cmdAsk only reads `llmPlanning` + `router`; build the smallest shape that satisfies it.
const fakeRt = (llmPlanning: boolean, router: ProviderRouter): Runtime =>
  ({ llmPlanning, router }) as unknown as Runtime;
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
});
