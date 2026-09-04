import { defineConfig } from 'vitest/config';

// Package-local unit tests for the orchestrator port: the rate table and the
// usage arithmetic, the fake adapter's behaviours, the Fly adapter's request
// shaping and state mapping, and the image-pull probe's parsing. They run with
// no server and no database — like the @motir/cli and @motir/design-system
// package suites — and stay out of the root vitest lane, whose `include` globs
// only `tests/**`. The `orchestrator` job in `ci.yml` is what runs them.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // ⚠️ THE GATE MOVED WITH THE CODE (MOTIR-4299). Ten of these files were in
    // the root `vitest.config.ts`'s `coverage.include` with a ≥90 per-file
    // floor; leaving the package without one would have made the extraction a
    // quiet way to drop a gate, which is the failure mode a boundary change is
    // most able to hide. Same numbers, same per-file shape, measured over the
    // package's own suite — `ci.yml`'s `orchestrator` job runs it.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The barrel re-exports and declares nothing; measuring it says only
      // whether something imported the package.
      exclude: ['src/index.ts'],
      thresholds: {
        perFile: true,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
