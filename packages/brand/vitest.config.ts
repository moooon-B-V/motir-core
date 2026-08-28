import { defineConfig } from 'vitest/config';

// Package-local guards for the brand chrome. Everything here reads the shipped
// SOURCE — `brand.css` and the geometry module — rather than rendering, so the
// suite needs no DOM, no server and no database, like the @motir/design-system
// and @motir/cli package suites. It stays out of the root vitest lane, which
// globs only `tests/**`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
  },
});
