import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';
import { GATED, REPORTED, SPECS } from './tests/helpers/atWorkStorySurface';

// STORY MOTIR-8413's `motir-core` COVERAGE FLOOR (MOTIR-8418) — Motir at work:
// the drafted card's orange pop and breath, and the Motir mark breathing in the
// rail header (`design/ai-chat/design-notes.md` § _Motir at work_).
//
// Same shape as `vitest.coverage.plan-progress.config.ts`: PER-FILE, `all: false`,
// the base config spread rather than replaced, scoped to the specs that reach
// these files. ONE difference, on purpose: the file lists and the spec list are
// not written here. They live in `tests/helpers/atWorkStorySurface.ts`, which the
// structural sweep (`tests/planning/atWorkSurfaceGuards.test.ts`) reads too, so
// the floor's files and the sweeps' subjects are one enumeration. That module
// imports nothing; this config is its only reader that spreads the root config.
//
// ⚠️ WHAT IS GATED AND WHAT IS ONLY REPORTED.
//   • GATED at the project floor (90 / 90 / 90 / 90) — the files this story
//     WROTE: `PlanAtWorkMark.tsx` (new), and `lib/plans/planProgress.ts`, whose
//     `readPlanAtWork` / `PLAN_AT_WORK_MOVES` this story added and whose own
//     suite this lane runs, so its whole-file number measures it.
//   • REPORTED, NOT GATED — the files it WIDENED: `PlanningCanvas.tsx`,
//     `PlanReviewCanvas.tsx`, `PlanProposalViews.tsx` and `PlanChangeRail.tsx`.
//     A per-file number over any of them measures older code this lane does not
//     run. The story's own arms in them are read off this lane's json report and
//     listed below.
//   • `app/globals.css` and `packages/design-system/theme.css` are enumerated for
//     the sweeps only: coverage instruments no stylesheet.
//
// It needs no database: every spec here renders or computes in-process (the poll
// is mocked at the seam). It still spreads the root config, whose global setup
// prepares the per-worker test databases, so run it where the suite runs.

/** Each file in {@link GATED} is held to this, whole-file. */
const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [...SPECS],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      reportsDirectory: 'coverage/plan-at-work',
      all: false,
      include: [...GATED, ...REPORTED],
      // Read off THIS lane's own command on 2026-10-14 (stmts / branch / fn / lines):
      //
      //   GATED
      //   PlanAtWorkMark.tsx             100 /   100 / 100 /   100
      //   planProgress.ts              97.59 /  92.7 / 100 /  97.1
      //
      //   REPORTED (whole-file; the story's own arms are read per line below)
      //   PlanChangeRail.tsx           58.62 / 46.89 / 46.42 / 60.45
      //   PlanProposalViews.tsx        86.95 / 87.09 /   100 / 86.36
      //   PlanReviewCanvas.tsx         69.01 /  58.4 /    65 / 74.35
      //   PlanningCanvas.tsx           71.73 / 70.64 / 76.59 / 73.65
      //
      // THE STORY'S ARMS IN THE REPORTED FILES — every statement and branch on a
      // line this story added (diffed against the merge base) is reached by this
      // lane, none left as a residual:
      //   · PlanningCanvas — `leavingCuesOf` (both loops, the moving-only rule;
      //     `planning-canvas-cues` § leavingCuesOf), the cue track's reduced-motion
      //     and retain arms (§ the at-work cue), `dropLeavingCue`'s already-dropped
      //     guard (§ "two fade ends in one batch"), the `onAnimationEnd` name test;
      //   · PlanReviewCanvas — the `moving` memo's empty and non-empty arms
      //     (`plan-review-canvas-cues` § the at-work motion);
      //   · PlanProposalViews — every `nextHeld` arm and `stepsKey` (the stalled
      //     hold in `plan-proposal-views`, and the seam's stalled / failing / null
      //     rows in `atWorkStoryGate`);
      //   · PlanChangeRail — the one mount (`plan-change-rail`'s render reaches it).
      //
      // ⚠️ THE NAMED RESIDUAL on a gated file: `planProgress.ts` 506-507, the
      // `default: never` arm of `atWorkStateOf` — `PlanProgressState` is a closed
      // union the switch is exhaustive over, so the arm exists for the compiler.
      thresholds: {
        perFile: true,
        ...Object.fromEntries(GATED.map((file) => [file, FLOOR])),
      },
    },
  },
});
