import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// MOTIR-8682 — the LOADTEST END-TO-END lane (Story MOTIR-8538).
//
// Its own config, modelled on `vitest.two-instance.config.ts`, so it never joins
// the default `vitest run`: it needs a production `next build`, a migrated
// Postgres and the pinned k6 + xk6-sse binary (`loadtest/k6/build.sh`), and it
// spawns `pnpm loadtest:run` twice for real — seed, k6, capture, report — against
// two `next start` instances behind a fake Fly proxy. `globalSetup` starts the
// instances, the proxy and the stub Prometheus/Neon API once; the specs are
// `*.spec.ts` under `tests/loadtest-e2e/`, a name the default config's
// `tests/**/*.test.{ts,tsx}` never matches.
//
// Files run one at a time: every spec reads the SAME fake platform's call log and
// the same database.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/loadtest-e2e/**/*.spec.ts'],
    globalSetup: ['./tests/loadtest-e2e/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    // A beforeAll here IS a whole load-test run (seed, ~2 min of k6, the report).
    hookTimeout: 900_000,
  },
  resolve: {
    alias: {
      '@': resolve(fileURLToPath(new URL('.', import.meta.url))),
      'server-only': resolve(
        fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
      ),
    },
  },
});
