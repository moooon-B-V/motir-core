import { defineConfig } from 'vitest/config';

// Package-local unit tests for @motir/pages (MOTIR-5757). They run with no
// server and no database, like the other package suites, and stay out of the
// root vitest lane, whose `include` globs only `tests/**`. The `pages` job in
// `ci.yml` is what runs them.
//
// The page editor's suites (MOTIR-7275, `test/editor/**`) are React component
// tests and run under jsdom (a `// @vitest-environment jsdom` line opens each
// file, the root config's per-file pattern); everything else stays on node.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    setupFiles: ['test/editor/setup.ts'],
    // The project's per-file floor, the same numbers the root config and
    // @motir/orchestrator hold. A package that ships without one is a quiet
    // way to drop a gate.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      // The barrels re-export and declare nothing; `types.ts` and the editor's
      // `messages.ts` declare types only and compile to nothing a run could
      // cover.
      exclude: ['src/index.ts', 'src/types.ts', 'src/editor/index.ts', 'src/editor/messages.ts'],
      thresholds: {
        perFile: true,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
