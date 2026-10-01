import { defineConfig } from 'vitest/config';

// Package-local unit tests for @motir/pages (MOTIR-5757). They run with no
// server and no database, like the other package suites, and stay out of the
// root vitest lane, whose `include` globs only `tests/**`. The `pages` job in
// `ci.yml` is what runs them.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The project's per-file floor, the same numbers the root config and
    // @motir/orchestrator hold. A package that ships without one is a quiet
    // way to drop a gate.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The barrel re-exports and declares nothing; `types.ts` declares types
      // only and compiles to nothing a run could cover.
      exclude: ['src/index.ts', 'src/types.ts'],
      thresholds: {
        perFile: true,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
