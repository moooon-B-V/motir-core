import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// STORY MOTIR-4905's `motir-core` COVERAGE FLOOR (MOTIR-5142).
//
// ⚠️ WHAT A FLOOR IS FOR HERE, AND WHAT IT IS NOT. It does not decide whether
// this story is correct — `tests/integration/workflows/approved-status-story-gate.test.ts`
// holds the properties a percentage cannot see, and each card shipped its own
// units. What a floor catches is the thing units cannot: a LATER change that
// deletes a branch's only test and leaves the branch, on a surface where a dead
// branch means a card is silently ranked, derived or painted wrong.
//
// ⚠️ PER-FILE, NEVER GLOBAL, and the numbers below were MEASURED on this branch
// before they were written — the sequence `vitest.config.ts` prescribes
// throughout. A round figure somebody liked is not a floor, it is a wish.
//
// ⚠️ FOUR FILES, AND THE TWO THIS STORY ALSO TOUCHED THAT ARE NOT HERE.
// `workItemRepository.ts` and `workItemsService.ts` are both already gated in
// the root config, and both are thousands of lines this story widened by a few;
// re-gating them in a story lane would gate MOTIR-4905 on code no card here
// wrote. `components/issues/StatusPill.tsx` and `lib/workflows/statusColor.ts`
// are likewise already gated, by MOTIR-3008's block. That leaves the four below:
// the ordering (`statusLadder`), the workflow that declares the status
// (`defaultWorkflow`), the derivation that reads the ordering
// (`parentStatusRollupService`) and the canvas metadata map that paints it
// (`canvasStatusMeta`).
//
// ⚠️ `packages/design-system/src/components/ui/Pill.tsx` IS NOT HERE EITHER, and
// not by oversight. That package has its own vitest project and no coverage
// provider at all, so gating one file in it means standing up a coverage lane
// for a package — a piece of build infrastructure, not this story's surface.
// The row it gained is asserted BEHAVIOURALLY through `components/issues/StatusPill.tsx`,
// which renders the real primitive and IS gated at 90 in the root config.
//
// ⚠️ IT RUNS THE SUITES THAT REACH THE SURFACE, NOT THE WHOLE TREE — the lesson
// `vitest.coverage.onboarding-routing.config.ts` paid 860 seconds to learn. The
// `include` below is the set of specs that actually touch these four files;
// anything outside it contributes no coverage to them, so scoping costs no
// measurement.
//
// ⚠️ AND IT DOES NOT OVERRIDE `resolve`. The base config's alias map carries the
// `server-only` stub and the plugin chain that resolves `@/…`; replacing it
// breaks every service import. Spread the base and change only what this lane
// is about.
//
// It needs Postgres: the rollup, the aggregate and the story gate all run
// against a real database, per the repository's own convention.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/workflows/*.test.ts',
      'tests/workItems/statusLadder.test.ts',
      'tests/integration/workflows/*.test.ts',
      'tests/jobs/status-derivation.test.ts',
      'tests/components/status-pill.test.tsx',
      'tests/components/plan-item-node.test.tsx',
      'tests/boards/default-board.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      all: false,
      include: [
        // The one ordering both halves of status derivation and the
        // container-completeness gate read. MOTIR-5140 put a sixth rung in it.
        'lib/workItems/statusLadder.ts',
        // Where the status is DECLARED — the row set the migration seeds and
        // every `Record<Union, …>` in the product is a subset of.
        'lib/workflows/defaultWorkflow.ts',
        // The derivation that reads the ladder. A wrong rank here does not throw;
        // it moves a parent backwards as its children move forwards.
        'lib/services/parentStatusRollupService.ts',
        // The canvas metadata map, including the open-set label fallback that
        // keeps a CUSTOMER's status from being renamed to one of ours.
        'lib/workflows/canvasStatusMeta.ts',
      ],
      // Read off THIS lane's own command on 2026-09-11, with the story gate in:
      //
      //   statusLadder.ts                 100 / 100 / 100 / 100
      //   defaultWorkflow.ts              100 / 100 / 100 / 100
      //   canvasStatusMeta.ts             100 / 100 / 100 / 100
      //   parentStatusRollupService.ts  95.13 /  90 / 100 / 100
      //
      // ⚠️ PINNED AT THE STORY'S 90 FLOOR, NOT AT THE READING. Three of the four
      // measure 100 on every axis, and a threshold of 100 would go red on the
      // next unrelated refactor that adds a line nobody thought to cover — a
      // ratchet that climbs on its own eventually fails a change that was fine.
      // The floor is the bar the card asks for; the headroom above it is what
      // keeps the gate about REGRESSIONS.
      thresholds: {
        perFile: true,
        'lib/workItems/statusLadder.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/workflows/defaultWorkflow.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/workflows/canvasStatusMeta.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        // ⚠️ THE ONE WITH NO HEADROOM ON BRANCHES, and the residuals are named
        // so the next author knows what they are rather than guessing. Three
        // arms stay uncovered, all of them race- or corruption-only:
        //   • the parent row VANISHING between `lockById` and `findById`, in
        //     the same transaction;
        //   • `no_matching_status` — a project in which not one of the ladder's
        //     six rungs resolves to a live status;
        //   • the `unresolvable` arm above them.
        // Each needs a mid-transaction delete or a workflow with its whole
        // ladder deleted. They are reachable, and a test for them would be a
        // test about the fixture rather than about the derivation — so they are
        // PINNED WITH A REASON rather than covered by something contrived.
        'lib/services/parentStatusRollupService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
      },
    },
  },
});
