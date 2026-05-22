// Live, key-gated end-to-end smoke — the ONLY path that makes a REAL LLM call.
// Every vitest injects a fake `fetch`; this proves the real createAiClient →
// provider → ProviderRouter wiring actually talks to a provider. It is safe to
// run unconditionally: with no provider key in the environment it SKIPs (exit
// 0) and calls nothing. With a key it makes two tiny real calls (maxTokens ≤
// 16) — one non-streaming, one streaming — so it charges a few real tokens.
//
//   ANTHROPIC_API_KEY=sk-... npm run smoke:live
//   OPENAI_API_KEY=sk-...    npm run smoke:live
//
// Never commit a key. Run from the repo root (it builds the real runtime from
// ./.archon/policy.yaml + archon.config.json).

import { buildRuntime } from '../src/runtime';

const TINY = 16; // bound the spend: a word or two is enough to prove the wire

async function main(): Promise<void> {
  const rt = await buildRuntime(process.cwd());
  try {
    if (!rt.llmPlanning) {
      console.log('SKIP: no provider key in env (set ANTHROPIC_API_KEY or OPENAI_API_KEY) — nothing called.');
      return;
    }
    console.log('live smoke: provider key present — making real calls (tiny maxTokens)…\n');

    const c = await rt.router.complete({
      taskClass: 'summarize',
      prompt: 'Reply with exactly the word: ok',
      maxTokens: TINY,
    });
    console.log(
      `  ✓ complete  [${c.modelId}] ${JSON.stringify(c.text.trim())}  (${c.inputTokens}+${c.outputTokens} tok, $${c.costUsd.toFixed(6)})`,
    );

    let streamed = '';
    const s = await rt.router.streamComplete(
      { taskClass: 'summarize', prompt: 'Reply with exactly the word: go', maxTokens: TINY },
      (chunk) => {
        streamed += chunk;
      },
    );
    console.log(`  ✓ stream    [${s.modelId}] ${JSON.stringify(streamed.trim())}  ($${s.costUsd.toFixed(6)})`);

    console.log(`\nlive smoke OK — session spend $${rt.router.spent.toFixed(6)}`);
  } finally {
    rt.close();
  }
}

main().catch((e: unknown) => {
  console.error(`live smoke FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
