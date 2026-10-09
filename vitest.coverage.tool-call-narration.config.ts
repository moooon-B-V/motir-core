import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// STORY MOTIR-7974's `motir-core` COVERAGE FLOOR (MOTIR-7981) — one line per tool
// call on the planning rail: the per-call rules and the act record that renders
// them, plus the frame map, the fold and the rail they widened.
//
// Same shape and same reasoning as `vitest.coverage.plan-progress.config.ts`:
// PER-FILE, measured on this branch before being pinned, scoped to the specs that
// actually reach these files, and the base config spread rather than replaced.
//
// ⚠️ WHAT IS GATED AND WHAT IS ONLY REPORTED.
//   • GATED at the project floor (90 / 90 / 90 / 90) — the two files this story
//     WROTE (`git diff --diff-filter=A origin/main...HEAD`): `planCallLines.ts`
//     and `PlanActRecord.tsx`.
//   • REPORTED, NOT GATED — the files it WIDENED: `planChangeFrames.ts` (the
//     `tool_call` / `tool_call_failed` kinds), `usePlanChangeConversation.ts`
//     (`narrateToolCall`, `applyPlanFrame`) and `PlanChangeRail.tsx` (which now
//     hands its record to `PlanActRecord`). A per-file number over any of them
//     measures its pre-existing code, which this lane does not run; the story's
//     own arms in them are read per function off this lane's json report.
//
// It needs Postgres: the story gate drives the anchored relay's permission gate
// against a real database, per the repository's own convention.

/** Each file below is held to {@link FLOOR}, whole-file. */
const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

export const GATED = [
  'components/planning/planCallLines.ts',
  'components/planning/PlanActRecord.tsx',
];

export const REPORTED = [
  'lib/planning/planChangeFrames.ts',
  'lib/hooks/usePlanChangeConversation.ts',
  'components/planning/PlanChangeRail.tsx',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The story gate — a recorded stream through the relay, the reader, the fold
      // and the rail, in en and zh.
      'tests/integration/planning/toolCallNarrationStoryGate.test.tsx',
      // MOTIR-7976 — the frame contract and the fold.
      'tests/components/plan-change-tool-call-frame.test.ts',
      'tests/components/plan-change-frame-totality.test.ts',
      'tests/api/plan-job-stream-relay-tool-call.test.ts',
      // MOTIR-7979 — the per-call rules, the lines, and the catalogue parity.
      'tests/components/plan-call-lines.test.ts',
      'tests/components/plan-change-call-lines.test.tsx',
      'tests/components/plan-change-catalogue-parity.test.ts',
      'tests/components/plan-change-act-rail.test.tsx',
      'tests/components/debug-turn-rail.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      reportsDirectory: 'coverage/tool-call-narration',
      all: false,
      include: [...GATED, ...REPORTED],
      // Read off THIS lane's own command on 2026-10-09 (stmts / branch / fn / lines):
      //
      //   GATED
      //   planCallLines.ts               98.06 / 91.72 / 100 / 98.36
      //   PlanActRecord.tsx              94.30 / 91.39 / 100 / 98.05
      //
      //   REPORTED (whole-file; the story's own arms are read per function)
      //   PlanChangeRail.tsx             64.67 / 54.96 / 60.97 / 66.11
      //   usePlanChangeConversation.ts    9.51 / 12.14 /  4.08 / 10.91
      //
      // The two unreached lines on gated files are reachable and simply unmeasured
      // — each file sits above the floor without them, so no test was added for the
      // number's sake: `fullValueKey`'s symbol and title arms (no suite renders a
      // shortened code-graph name or title), and `PlanActRecord`'s reset of the
      // reader's expansions when a NEW run replaces the record. Pinned at the floor,
      // never at the reading.
      thresholds: {
        perFile: true,
        ...Object.fromEntries(GATED.map((file) => [file, FLOOR])),
      },
    },
  },
});
