import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// STORY MOTIR-8136's `motir-core` COVERAGE FLOOR (MOTIR-8143) — the outage signal's
// consuming half: the reader, the settle branches, the mapped column and the two faces.
// Same shape as `vitest.coverage.code-read.config.ts`: PER-FILE, scoped to the specs that
// reach these files, the base config spread rather than replaced. Needs Postgres.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/planning/codeUnreadable.test.ts',
      'tests/components/plan-change-code-unreadable.test.tsx',
      'tests/components/plan-change-code-unreadable-reload.test.tsx',
      'tests/integration/planning/codeUnreadableOutage.test.ts',
      'tests/ai/planChangePlannerTurn.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      all: false,
      include: ['lib/planning/codeUnreadable.ts', 'components/planning/CodeUnreadableTurn.tsx'],
      thresholds: { perFile: true, statements: 90, branches: 90, functions: 90, lines: 90 },
    },
  },
});
