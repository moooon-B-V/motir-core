import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// STORY MOTIR-7797's `motir-core` COVERAGE FLOOR (MOTIR-7806) — a confirmed bug
// is filed the moment it is confirmed, from any planning session and from Guide
// me through.
//
// ⚠️ WHAT THIS FLOOR IS FOR. It does not decide whether the story is correct —
// `tests/integration/ai/story-bug-filing-gate.test.ts` holds the cross-cutting
// properties a percentage cannot see, and each subtask shipped its own units.
// What it catches is a LATER change that deletes a branch's only test and keeps
// the branch, on a surface where a dead branch is an unbounded or misplaced
// filing into a customer's tree.
//
// ⚠️ PER-FILE, NEVER GLOBAL, and only the story's CHANGED motir-core files:
//   - `lib/services/guideBugFilingService.ts` — the guide's filing (new);
//   - `lib/ai/guideWorkItem.ts`               — the `file_bug` wire + its caps;
//   - `lib/services/guideLandingService.ts`   — the `file_bug` landing case.
// Each carries the story's per-file standard, ≥ 90 on all four metrics, and
// none is lowered. Reading taken 2026-10-08 with this lane's own command
// (`pnpm coverage:bug-filing`), statements / branches / functions / lines:
//   - guideBugFilingService.ts  95.34 / 93.54 / 100 / 100
//   - guideWorkItem.ts           100  / 97.65 / 100 / 100
//   - guideLandingService.ts    96.53 / 90.68 / 100 / 96.65
// ⚠️ THE LANDING'S BRANCH FLOOR HAS LITTLE HEADROOM. The merged suite measured
// it at 81.37: the landing's pre-story branches (the close walk's workflow
// shapes, an approval holding the close, a refusal from the card's own service)
// were unexercised. The remedy the card prescribes is a case, not a lower
// floor, so the gate file's last `describe` lands each of those actions in the
// SAME turn as a filing. What stays uncovered is mostly unreachable while the
// code stands: the plural "Filed bugs:" (one filing per turn), a skipped
// outcome without a reason, a guide session without a target key, and a
// write_todos with no rows (the parser refuses one).
//
// ⚠️ `lib/services/aiWorkItemsService.ts` IS DELIBERATELY NOT HERE. This story
// changed only a doc comment there (MOTIR-7799's PLANLESS JOBS paragraph); the
// route's behaviour this story relies on is asserted by the gate file and by
// `tests/integration/ai/logBug*.test.ts`. A per-file floor over a large file the
// story did not change would be a number about other stories.
//
// ⚠️ IT RUNS THE SUITES THAT REACH THE SURFACE, NOT THE WHOLE TREE (the
// `vitest.coverage.onboarding-routing.config.ts` lesson): the specs below are
// the ones that import these files, so scoping costs no measurement.
//
// ⚠️ AND IT DOES NOT OVERRIDE `resolve` — spread the base and change only what
// this lane is about (the base carries the `server-only` stub and the `@/…`
// resolution every service import needs).
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/ai/guide*.test.ts',
      'tests/integration/ai/logBug*.test.ts',
      'tests/integration/ai/story-bug-filing-gate.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      all: false,
      include: [
        'lib/services/guideBugFilingService.ts',
        'lib/ai/guideWorkItem.ts',
        'lib/services/guideLandingService.ts',
      ],
      thresholds: {
        perFile: true,
        'lib/services/guideBugFilingService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/ai/guideWorkItem.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/services/guideLandingService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
      },
    },
  },
});
