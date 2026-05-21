import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdAsk } from './commands';
import type { Runtime } from './runtime';
import type { ModelSpec } from './core/types';
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

// A streaming client whose textStream yields two chunks — enough to prove cmdAsk
// writes incrementally. `complete`/`completeObject` are required by the contract
// but unused on the /ask path, so they assert if reached.
const streamingClient: ProviderClient = {
  provider: 'fake',
  complete: () => Promise.reject(new Error('unused on /ask path')),
  completeObject: () => Promise.reject(new Error('unused on /ask path')),
  completeStream: () => {
    async function* gen(): AsyncGenerator<string> {
      yield 'hel';
      yield 'lo';
    }
    return { textStream: gen(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) };
  },
};

// cmdAsk only reads `llmPlanning` + `router`; build the smallest shape that satisfies it.
const fakeRt = (llmPlanning: boolean, router: ProviderRouter): Runtime =>
  ({ llmPlanning, router }) as unknown as Runtime;

describe('cmdAsk (streaming /ask)', () => {
  it('streams the answer to stdout, then prints the model + cost line', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const router = new ProviderRouter([model], [streamingClient]);

    await cmdAsk(fakeRt(true, router), 'what is this repo?');

    expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain('hello');
    expect(log.mock.calls.flat().join('\n')).toContain('— m'); // model attribution footer
  });

  it('short-circuits with guidance when no LLM provider is configured', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const router = new ProviderRouter([], []);

    await cmdAsk(fakeRt(false, router), 'hi');

    expect(log.mock.calls.flat().join('\n')).toContain('no LLM provider configured');
  });
});
