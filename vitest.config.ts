import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run the TypeScript sources only — never the compiled mirror under dist/.
    // Without this, `bun run build` artifacts (dist/**/*.test.js) get collected
    // too, double-running the suite against possibly-stale compiled copies that
    // could mask a regression in the real (src) tests.
    include: ['src/**/*.test.ts'],
  },
});
