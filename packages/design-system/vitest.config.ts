import { defineConfig } from 'vitest/config';

// Package-local unit tests for the extracted design system: the registries load
// (pure data), the theme-apply API resolves axes → the applied `[data-*]` set,
// and the primitives + specimen mount (rendered via react-dom/server, so no
// jsdom / testing-library dependency is needed — the components are plain React
// once the `'use client'` directive is a no-op outside Next). These run with no
// server and no DB, like the @motir/cli package suite; they stay out of the
// root vitest lane (which globs only `tests/**`).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
  },
});
