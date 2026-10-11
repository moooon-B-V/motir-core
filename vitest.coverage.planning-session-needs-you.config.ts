import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for A PLANNING SESSION THAT NEEDS YOU — Story MOTIR-7905's integration gate,
// MOTIR-7919: the failure record and its stop point, the planning-session gate (a planner's
// question or a conversation left waiting on its person), the resume door, and the Workbench /
// overlay parts that render them.
//
// ⚠️ MEASURED: the files the story ADDED. NOT measured: the large shared files it extended by a
// clause each (`planSessionEndService`, `abandonedPlanService`, `planTargetLockService`,
// `homeService`, `planRepository`, `approvalGatesService`, `approvalGateRepository`,
// `planChangeSessionRepository`, `planChangeSessionsService`, `usePlanChangeConversation`).
// Those sit under their own suites; the story's lines in them are executed by the suites below
// (`planSessionEndService` is additionally held by the `story-7630-coverage` floors, which stay
// green unedited).
//
// The floors are the MEASURED reading over the lane's suites, rounded DOWN, PER FILE, and a
// RATCHET: raise them when a file improves, never lower one to land a change. CI: the
// `story-7905-coverage` job, which needs Postgres.

const MEASURED = [
  'lib/planChange/sessionWaitingState.ts',
  'lib/planChange/failureRecord.ts',
  'lib/planChange/failedWaitingTurn.ts',
  'lib/planChange/toResumeForm.ts',
  'lib/services/planningSessionGateService.ts',
  'lib/approvalGates/planningSessionHandler.ts',
  'lib/services/planSessionResumeService.ts',
  'app/api/ai/plan-change/session/resume/route.ts',
  'components/planning/SessionWaitingParts.tsx',
  'components/approvals/PlanningSessionRow.tsx',
  'app/*/workbench/_components/PlanningSessionResumeEntry.tsx',
  'app/*/workbench/_components/PlanningSessionResumeForms.tsx',
  'app/*/workbench/_components/planningSessionWords.ts',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // the chain (this card) and each card's own integration suite
      'tests/integration/planning/planningSessionNeedsYouStoryGate.test.ts',
      'tests/integration/planning/sessionFailureWaits.test.ts',
      'tests/integration/planning/planChangeSessionWaitingState.test.ts',
      'tests/integration/planning/sessionResume.test.ts',
      'tests/integration/planning/sessionResumeBindArms.test.ts',
      'tests/integration/planning/sessionDtoFailedWaiting.test.ts',
      'tests/integration/planning/failedSessionTurnContinues.test.ts',
      'tests/integration/planning/situationTwoChain.test.ts',
      'tests/integration/approvals/planningSessionGate.test.ts',
      // pure units and the rendering
      'tests/planChange/planningSessionNeedsYouUnits.test.ts',
      'tests/planChange/resumeRoute.test.ts',
      'tests/components/planning-session-branches.test.tsx',
      'tests/workbench/planningSessionWords.test.ts',
      'tests/components/approval-row-planning-session.test.tsx',
      'tests/components/workbench-to-resume-planning-session.test.tsx',
      'tests/components/workbench-to-resume-situation-two.test.tsx',
      'tests/components/plan-change-rail-waiting.test.tsx',
      'tests/components/plan-change-rail-failed-with-waiting-plan.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'json'],
      all: true,
      include: MEASURED,
      thresholds: {
        'lib/planChange/sessionWaitingState.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/planChange/failureRecord.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/planChange/failedWaitingTurn.ts': {
          statements: 100,
          branches: 93,
          functions: 100,
          lines: 100,
        },
        'lib/planChange/toResumeForm.ts': {
          statements: 100,
          branches: 95,
          functions: 100,
          lines: 100,
        },
        'lib/services/planningSessionGateService.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/approvalGates/planningSessionHandler.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/services/planSessionResumeService.ts': {
          statements: 97,
          branches: 97,
          functions: 100,
          lines: 100,
        },
        'app/api/ai/plan-change/session/resume/route.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'components/planning/SessionWaitingParts.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'components/approvals/PlanningSessionRow.tsx': {
          statements: 100,
          branches: 95,
          functions: 100,
          lines: 100,
        },
        'app/*/workbench/_components/PlanningSessionResumeEntry.tsx': {
          statements: 100,
          branches: 98,
          functions: 100,
          lines: 100,
        },
        'app/*/workbench/_components/PlanningSessionResumeForms.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'app/*/workbench/_components/planningSessionWords.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
