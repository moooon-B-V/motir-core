import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for the SESSION LIFECYCLE — Story MOTIR-7630's integration gate,
// MOTIR-7644 (`docs/decisions/agent-authored-plans.md` AMENDMENT 23): the one end
// operation and its callers, the overlay's end parts, and the small pure readers
// the story rewrote (the hold predicate and the Plans row view).
//
// ⚠️ MEASURED: the files the story ADDED, plus the small files it rewrote. NOT
// measured: the large shared services it extended by a clause each
// (`planChangeSessionsService`, `planTargetLockService`, `workItemsService`,
// `plansService`, the conversation hook), which sit under their own suites — the
// story's lines in them are exercised by the suites below.
//
// The floors are the MEASURED reading over the lane's suites, rounded DOWN, PER FILE,
// and they are a RATCHET. CI: the `story-7630-coverage` job, which needs Postgres.

const MEASURED = [
  'lib/services/planSessionEndService.ts',
  'components/planning/SessionEndParts.tsx',
  'lib/plans/planHold.ts',
  'app/*/plans/sessionRowView.ts',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/planning/planSessionEnd.test.ts',
      'tests/planning/planSessionEndBackfill.test.ts',
      'tests/planning/planSessionFailureEnds.test.ts',
      'tests/planning/planSessionCopy.test.ts',
      'tests/planning/planHoldGuard.test.ts',
      'tests/planning/plansSessionListServer.test.ts',
      'tests/integration/planning/sessionLifecycle.test.ts',
      'tests/integration/planning/planHoldMovers.test.ts',
      'tests/integration/plans/planSessionsList.test.ts',
      'tests/components/plan-change-rail-session-end.test.tsx',
      'tests/components/use-plan-change-session-end.test.tsx',
      'tests/components/session-end-parts.test.tsx',
      'tests/planning/sessionHoldPredicate.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      all: true,
      include: MEASURED,
      // PER FILE, MEASURED 2026-10-06 at MOTIR-7644 over this lane's suites, rounded DOWN.
      thresholds: {
        'lib/services/planSessionEndService.ts': {
          statements: 95,
          branches: 91,
          functions: 100,
          lines: 100,
        },
        'components/planning/SessionEndParts.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/plans/planHold.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'app/*/plans/sessionRowView.ts': {
          statements: 100,
          branches: 94,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
