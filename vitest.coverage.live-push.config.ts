import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// THE LIVE-PUSH STORY'S COVERAGE FLOOR (Story MOTIR-8542 · MOTIR-8733) — every
// motir-core file the story's code cards ADDED or rewrote (MOTIR-8727 … MOTIR-8732),
// each held to the per-file floor of 90% statements, functions, branches and lines
// that every story lane uses. Measured over the story gate
// (`tests/integration/live/liveStoryGate.test.ts`: real triggers, the real hub, the
// real route, against Postgres) plus each card's own suite. Mirrors
// `vitest.coverage.to-resume.config.ts`.
//
// ⚠️ PER-FILE, NEVER GLOBAL — a file's own untested branch cannot hide behind a
// neighbour's surplus.
//
// ⚠️ THE GLOBS NEVER SPELL A ROUTE GROUP OR A DYNAMIC SEGMENT (MOTIR-2449).

const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

/** Every file below is held to {@link FLOOR}, whole-file. */
export const MEASURED = [
  // MOTIR-8728 — the payload, the listener and its connection helper.
  'lib/live/liveNotification.ts',
  'lib/live/liveSignalHub.ts',
  'lib/live/liveSignalTables.ts',
  // MOTIR-8729 / MOTIR-8730 — the stream's session, coalescer, plan watch and route.
  'lib/workbench/workbenchStreamSession.ts',
  'lib/workbench/workbenchStreamCoalescer.ts',
  'lib/workbench/planWatch.ts',
  'app/api/workbench/stream/route.ts',
  // MOTIR-8731 / MOTIR-8732 — the tab's one stream and the plan poll it drives.
  'lib/live/sources/workbenchStreamSource.ts',
  'lib/hooks/useGeneratingPlanPoll.ts',
];

/**
 * SHARED files the story also changed, NAMED and deliberately NOT floored here: the
 * story added ONE method (`readReviewVersionForReader`) to a large, older service
 * whose remainder is other stories' code measured by their own suites. A whole-file
 * floor here would measure those stories, not this one. The method's own lines are
 * reached by the gate and `planReviewVersionForReader.test.ts`.
 */
export const SHARED_NOT_FLOORED = ['lib/services/planReviewService.ts'];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/integration/live/liveStoryGate.test.ts',
      'tests/integration/live/liveSignalTriggers.test.ts',
      'tests/integration/plans/planReviewVersionForReader.test.ts',
      'tests/api/workbench-stream-route.test.ts',
      'tests/lib/live/liveSignalHub.test.ts',
      'tests/lib/live/liveSignal.test.tsx',
      'tests/lib/live/workbenchStreamSource.test.ts',
      'tests/lib/live/workbenchStreamSource.plan.test.ts',
      'tests/lib/workbench/planWatch.test.ts',
      'tests/lib/workbench/workbenchStreamPlanWatch.test.ts',
      'tests/lib/workbench/workbenchStreamSession.test.ts',
      'tests/hooks/useGeneratingPlanPoll.test.ts',
      'tests/hooks/useGeneratingPlanPoll.push.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json'],
      reportsDirectory: 'coverage/live-push',
      all: true,
      include: MEASURED,
      thresholds: {
        perFile: true,
        ...FLOOR,
      },
    },
  },
});
