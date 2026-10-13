import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for A PLANNING JOB THAT LOSES ITS MACHINE RESUMES BY ITSELF — Story MOTIR-8301's
// motir-core gate, MOTIR-8310: the lost-machine fact read from motir-ai's raw problem
// (MOTIR-8304), the session's bounded record of automatic resumes (MOTIR-8305), the automatic
// resume through the relay and the sweep (MOTIR-8307), and the *resuming* progress state and its
// rendering (MOTIR-8309).
//
// ⚠️ NO PER-FILE FLOOR. The story added no production FILE of size: its code lands as clauses in
// shared files (`planSessionResumeService`, `planSessionEndService`, `abandonedPlanService`,
// `planChangeSessionRepository`, `planProgress`, `planProgressService`, `motirAiClient`,
// `PlanProgressLine`, …), whose other lines belong to other stories and sit under their own
// lanes. A floor over a whole shared file would measure those, not this story. What is measured
// instead is that EVERY statement and branch the story ADDED — `git diff -w` against the story's
// base, 73d4758ca — is executed by this lane's suites. Read with this lane's `json` report on
// 2026-10-12, every added statement and branch in MEASURED below ran, except these, none of which
// a shipped door can reach:
//
//   * `planSessionResumeService.ts`, `if (n === null) throw new AutoResumeBoundSpent()` — the
//     bound inside `recordAutoResume`'s own statement. The automatic precheck refuses a spent
//     bound first (`bound_spent`), and the bind's row lock plus its `failedJobId` re-check admit
//     ONE bind per recorded failure, so no second bind can reach the increment at the bound.
//     Defence in depth, kept on purpose; MOTIR-8310's PR shows a read-then-increment (and a
//     statement with no bound at all) both pass the chain for exactly this reason.
//   * `planSessionResumeService.ts`, the bind's `recordResumedAttempt(…)` false arm and the
//     precheck's `if (!project)` — both re-read rows the same transaction already holds (the
//     session under its lock; the project the session belongs to, which cannot be deleted while
//     the session exists).
//   * `planSessionResumeService.ts`, `throw err` after the lost-race test — an error that is not
//     a lost race (a database failure) mid-bind; nothing in-process produces one.
//   * `planSessionEndService.ts` (`readFailedJob`), the `?? false` of `view.lostMachine` — the
//     real `getJob` always sets it; it is optional only so a test's `readJob` may omit it.
//   * `abandonedPlanService.ts`, the `catch` around `getFailedJobFacts` — the shipped
//     `readFailedJobFacts` catches its own read and never throws; only an injected one could.
//
// The existing story lanes (`session-lifecycle`, `plan-progress`, `planning-session-needs-you`,
// `tool-call-narration`, …) keep their own floors, unedited. CI: the `story-8301-coverage` job,
// which needs Postgres.

const MEASURED = [
  'lib/ai/motirAiClient.ts',
  'lib/ai/errors.ts',
  'lib/planChange/failureRecord.ts',
  'lib/planChange/sessionWaitingState.ts',
  'lib/plans/planProgress.ts',
  'lib/repositories/planChangeSessionRepository.ts',
  'lib/services/abandonedPlanService.ts',
  'lib/services/planProgressService.ts',
  'lib/services/planReviewService.ts',
  'lib/services/planSessionEndService.ts',
  'lib/services/planSessionResumeService.ts',
  'lib/jobs/definitions/abandonedPlanSweep.ts',
  'components/planning/PlanProgressLine.tsx',
  'components/planning/PlanActRecord.tsx',
  'components/planning/PlanChangeRail.tsx',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // the chain (this card)
      'tests/integration/planning/lostMachineAutoResume.test.ts',
      // every test file the four predecessors added or modified
      'tests/ai/motirAiClient.test.ts',
      'tests/ai/planChangeSessionsCoverage.test.ts',
      'tests/planning/failureRecord.test.ts',
      'tests/plans/planProgress.test.ts',
      'tests/jobs/step-result-shape-guard.test.ts',
      'tests/integration/planning/lostMachineFact.test.ts',
      'tests/integration/planning/sessionAutoResumeRecord.test.ts',
      'tests/integration/planning/sessionAutoResume.test.ts',
      'tests/integration/planning/sessionFailureWaits.test.ts',
      'tests/integration/planning/failureBesideWaitingPlan.test.ts',
      'tests/integration/planning/silentPlanSweep.test.ts',
      'tests/integration/planning/planningSessionNeedsYouStoryGate.test.ts',
      'tests/integration/planning/midRunAsk.test.ts',
      'tests/integration/planning/midRunTurnsStoryGate.test.ts',
      'tests/integration/plans/planProgressResuming.test.ts',
      'tests/integration/plans/planProgressService.test.ts',
      'tests/integration/plans/planReviewVersion.test.ts',
      // the rendering
      'tests/components/planProgressLine.resuming.test.tsx',
      'tests/components/plan-change-rail-auto-resume.test.tsx',
      'tests/components/plan-change-act-rail.test.tsx',
      'tests/components/plan-progress-line.test.tsx',
      'tests/components/plan-proposal-views.test.tsx',
      'tests/components/workbench-planning-tab.test.tsx',
      'tests/components/workbench-planning-list-poll.test.tsx',
      'tests/components/workbench-to-resume-planning-session.test.tsx',
      'tests/components/workbench-to-resume-situation-two.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: 'coverage/lost-machine-auto-resume',
      all: true,
      include: MEASURED,
    },
  },
});
