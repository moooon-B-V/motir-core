import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// MOTIR-8616 — the TWO-INSTANCE lane (Story MOTIR-8547).
//
// Its own config so it never joins the default `vitest run`: it needs a
// production `next build` and starts two `next start` processes, which no other
// lane pays for. `globalSetup` starts the pair once per run; the specs are
// `*.spec.ts` under `tests/two-instance/`, a name the default config's
// `tests/**/*.test.{ts,tsx}` never matches.
//
// Files run one at a time: every spec talks to the SAME two servers and the same
// database, and a limit case counts across both — two files in parallel would
// spend each other's budgets.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/two-instance/**/*.spec.ts'],
    globalSetup: ['./tests/two-instance/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
  resolve: {
    alias: {
      '@': resolve(fileURLToPath(new URL('.', import.meta.url))),
      // The limit cases seed tokens through the app's own services, which import
      // the Next build-time marker; the same empty stub every other lane uses.
      'server-only': resolve(
        fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
      ),
    },
  },
});
