import { defineConfig } from 'vitest/config';

// Package-local unit tests for the pure layers (config stores, link
// resolution, tool-error mapping). The full integration suite that spawns the
// built binary against a live MCP endpoint is Subtask 7.9.5; these run with no
// server and no DB, so they stay in the package and out of the root vitest lane
// (which globs only `tests/**`). 7.9.5 wires the package into the coverage gate.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
