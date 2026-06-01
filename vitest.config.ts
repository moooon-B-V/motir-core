import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

// Load .env into process.env before Vitest evaluates the test files. Next.js
// does this automatically at runtime; Vitest does not. Without this load,
// lib/db.ts throws "DATABASE_URL is not set" at module-import time and the
// suite fails before any test runs.
loadEnv();

// Test-only defaults for the env vars `lib/auth/index.ts` reads at module
// load. We do NOT overwrite anything a developer set in .env (override:false
// is dotenv's default). These placeholders only kick in when a CI/dev shell
// has nothing set — they let the auth module import without throwing, which
// is required for any test that touches Better-Auth's surface. They never
// reach a real OAuth server.
process.env['GOOGLE_CLIENT_ID'] ??= 'test-google-client-id';
process.env['GOOGLE_CLIENT_SECRET'] ??= 'test-google-client-secret';
process.env['BETTER_AUTH_SECRET'] ??= 'test-better-auth-secret-32-bytes-long-please';

// Vitest defaults to the Node environment for integration tests against a
// real Postgres. The first browser-style component test arrived in Story 1.4
// (the Markdown render smoke test): it opts into happy-dom per-file via a
// `// @vitest-environment happy-dom` directive at the top of the file, so the
// global default stays `node` and the DB-backed suites are unaffected. If
// component tests proliferate, split this into `vitest.workspace.ts` rather
// than dual-moding here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // DB-backed tests share connections to the local Postgres; running
    // them in parallel forks would cause cross-test row interference.
    // Serial is fine — total suite is small.
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    testTimeout: 15_000,
    // Coverage (Subtask 1.4.7). The work-item data model's load-bearing
    // modules — the service + its three repositories — must stay at ≥90%
    // branches/functions/lines. We scope `include` to exactly those four
    // files so the report (and the per-file thresholds below) is focused on
    // the surface 1.4.7 is responsible for, rather than diluting the signal
    // across the whole tree. Other modules carry their own coverage stories in
    // their own Subtasks. v8 is the provider (matches @vitest/coverage-v8).
    coverage: {
      provider: 'v8',
      include: [
        'lib/services/workItemsService.ts',
        'lib/repositories/workItemRepository.ts',
        'lib/repositories/workItemLinkRepository.ts',
        'lib/repositories/workItemRevisionRepository.ts',
      ],
      reporter: ['text', 'text-summary'],
      // Per-file thresholds keyed by glob: each of the four modules gates
      // independently, so a regression in any one fails the run (rather than a
      // blended average hiding a weak module).
      thresholds: {
        'lib/services/workItemsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemLinkRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemRevisionRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(fileURLToPath(new URL('.', import.meta.url))),
    },
  },
});
