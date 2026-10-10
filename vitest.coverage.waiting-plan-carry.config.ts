import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for A WAITING PLAN KEEPS ITS CONVERSATION — Story MOTIR-7928's integration
// gate, MOTIR-7933: an ended session whose plan still waits is carried, on its owner's
// first turn, into a new session that owns the plan; the next turn revises that plan;
// a stale one is said and replaced by one fresh plan.
//
// ⚠️ WHAT A FLOOR IS FOR HERE. Whether the assembled path is right is
// `tests/integration/planning/waitingPlanCarryGate.test.ts`'s question (the carry as
// one transaction, the races, the next turn's revise across the carry, the gate in
// Waiting on you). What a floor catches is what that cannot: a LATER change that
// deletes a branch's only test and leaves the branch.
//
// ⚠️ GATED: the files the story CREATED, PER FILE, at the MEASURED reading over this
// lane's suites, rounded DOWN, never below 90. A RATCHET. CI: the
// `story-7928-coverage` job, which needs Postgres.
//
// ⚠️ REPORTED, NOT GATED: the shared files the story CHANGED (the
// `vitest.coverage.plan-overlay-only.config.ts` precedent). A whole-file floor on
// `planChangeSessionsService.ts` (2,700 lines) or `plansService.ts` would measure
// other stories' lines; the story's own lines in each are listed, with what reaches
// them, in MOTIR-7933's pull-request description.

const CREATED = [
  'lib/planChange/classifySessionTurn.ts',
  'lib/planning/sessionCarry.ts',
  'lib/planning/planSessionClientErrors.ts',
  'components/planning/StalePlanNotice.tsx',
];

const SHARED = [
  'app/api/ai/plan-change/_errors.ts',
  'app/api/ai/plan-change/session/route.ts',
  'app/api/ai/plan-change/session/submit/route.ts',
  'lib/planChange/errors.ts',
  'lib/planning/planChangeClient.ts',
  'lib/repositories/planRepository.ts',
  'lib/repositories/planRevisionRepository.ts',
  'lib/services/aiPlanEditsService.ts',
  'lib/services/planChangeSessionsService.ts',
  'lib/services/planDriftService.ts',
  'lib/services/planRevisionsService.ts',
  'lib/services/planSessionEndService.ts',
  'lib/hooks/usePlanChangeConversation.ts',
  'components/planning/SessionEndParts.tsx',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The story gate (MOTIR-7933).
      'tests/integration/planning/waitingPlanCarryGate.test.ts',
      // Each code card's own suite (MOTIR-7930 · 7945 · 7932).
      'tests/planning/planSessionCarry.test.ts',
      'tests/integration/planning/sessionTurnOnWaitingPlan.test.ts',
      'tests/planChange/classifySessionTurn.test.ts',
      'tests/planning/planSessionClientMapping.test.ts',
      'tests/planChange/mapPlanChangeErrorSessionTurn.test.ts',
      'tests/components/plan-change-rail-session-end.test.tsx',
      'tests/components/use-plan-change-session-end.test.tsx',
      'tests/components/stale-plan-notice.test.tsx',
      'tests/components/use-plan-change-stale-plan.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      all: true,
      include: [...CREATED, ...SHARED],
      // PER FILE, MEASURED 2026-10-09 at MOTIR-7933 over this lane's suites, rounded DOWN.
      // Uncovered on purpose: `classifySessionTurn`'s last refusal (:50 — a Plan it
      // again naming the latest plan while it is still `generating`, which no
      // surface offers), and `StalePlanNotice`'s empty-status-label arms.
      thresholds: {
        'lib/planChange/classifySessionTurn.ts': {
          statements: 94,
          branches: 95,
          functions: 100,
          lines: 91,
        },
        'lib/planning/sessionCarry.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/planning/planSessionClientErrors.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'components/planning/StalePlanNotice.tsx': {
          statements: 100,
          branches: 90,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
