import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// STORY MOTIR-4753's `motir-core` COVERAGE FLOOR (MOTIR-4761).
//
// ⚠️ WHAT A FLOOR IS FOR HERE, AND WHAT IT IS NOT. It does not decide whether
// this story is correct — `tests/integration/onboarding/story-4753-gate.test.ts`
// holds the four properties a percentage cannot see, and each card shipped its
// own units. What this catches is the thing units cannot: a LATER change that
// deletes a branch's only test and leaves the branch, on a surface where a dead
// branch means a user is routed somewhere nobody meant.
//
// ⚠️ PER-FILE, NEVER GLOBAL. A global number over this repository is a number
// about the repository, and it moves when anything else does. These six files
// are the story's changed `motir-core` surface, and each carries its own floor
// read off the MERGED result rather than a round figure somebody liked.
//
// ⚠️ AND THE FLOORS ARE FLOORS — set at, or just under, what the merged suite
// actually measures, so the gate goes RED on a regression rather than on an
// unrelated refactor. Raising one is a deliberate act; nothing raises them
// automatically, because a ratchet that climbs on its own eventually fails a
// change that was fine.
//
// ⚠️ IT RUNS THE SUITES THAT REACH THE SURFACE, NOT THE WHOLE TREE. The first
// revision of this config ran all 1 546 files for 860 seconds to measure six —
// which is a gate nobody will run locally and a CI job that pays the sharded
// suite's whole bill a second time. The `include` below is the set of specs that
// actually touch these files; anything outside it contributes no coverage to
// them, so scoping costs no measurement and buys back fourteen minutes.
//
// ⚠️ AND IT DOES NOT OVERRIDE `resolve`. The base config's alias map carries the
// `server-only` stub (that import is a Next build-time marker with no plain-node
// resolution) and the plugin chain that resolves `@/…`; replacing it broke every
// service import with `Failed to resolve import "server-only"`. Spread the base
// and change only what this lane is about.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/onboarding/**/*.test.ts',
      'tests/planning/**/*.test.ts',
      'tests/migrate-onboarding/**/*.test.ts',
      'tests/integration/onboarding/**/*.test.ts',
      'tests/components/planning-*.test.tsx',
      'tests/components/onboarding*.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      all: false,
      include: [
        // The read every other surface names things from.
        'lib/services/onboardingSubstrateService.ts',
        // The wall that came down, and the verdict this side carries.
        'lib/planning/workspaceHost.ts',
        'lib/dto/onboardingRouting.ts',
        // The move out, and the way back.
        'lib/planning/onboardingHandoff.ts',
        'lib/planning/onboardingReturn.ts',
        // The entrance predicate that stopped deciding on an item count alone.
        'lib/onboarding/migrateHandoff.ts',
      ],
      thresholds: {
        perFile: true,
        'lib/services/onboardingSubstrateService.ts': {
          statements: 90,
          functions: 90,
          branches: 75,
          lines: 90,
        },
        'lib/planning/workspaceHost.ts': {
          statements: 90,
          functions: 90,
          branches: 75,
          lines: 90,
        },
        'lib/dto/onboardingRouting.ts': {
          statements: 85,
          functions: 85,
          branches: 75,
          lines: 85,
        },
        'lib/planning/onboardingHandoff.ts': {
          statements: 85,
          functions: 85,
          branches: 70,
          lines: 85,
        },
        'lib/planning/onboardingReturn.ts': {
          statements: 85,
          functions: 85,
          branches: 70,
          lines: 85,
        },
        'lib/onboarding/migrateHandoff.ts': {
          statements: 85,
          functions: 85,
          branches: 75,
          lines: 85,
        },
      },
    },
  },
});
