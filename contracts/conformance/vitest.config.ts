import { defineConfig } from 'vitest/config';

// Scenario suite run against one backend:
//   BASE_URL=http://localhost:8081 IMPL=java npm run conformance
// Results: conformance/results/<IMPL>-scenarios.json (Vitest JSON reporter) feed the compatibility table.
const impl = process.env.IMPL ?? 'unknown';
// Vite defines its own BASE_URL ("/") inside test workers, so forward ours under a private name.
const baseUrl = process.env.BASE_URL ?? '';

export default defineConfig({
  test: {
    root: new URL('.', import.meta.url).pathname,
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    fileParallelism: false, // auth, live and me scenarios mutate shared fixture state
    sequence: { concurrent: false },
    reporters: ['default', 'json'],
    outputFile: { json: `results/${impl}-scenarios.json` },
    env: { TR_CONFORMANCE_BASE_URL: baseUrl },
  },
});
