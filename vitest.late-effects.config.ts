import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// The COMPONENT-TEST EFFECT-ORDERING AUDIT lane (MOTIR-1737).
//
// Runs the browser-environment (happy-dom) test files with
// `tests/helpers/lateEffects.ts` appended to `setupFiles`. That shim defers
// React's passive-effect flush behind the `setTimeout(0)` RTL drains on, which
// turns the latent "assertion resolves before the effect lands" race into a
// DETERMINISTIC failure — with no added delay, so it never manufactures a false
// "too slow" failure. See tests/helpers/lateEffects.ts for the full mechanism.
//
// WHY A SEPARATE LANE, NOT PR CI (the MOTIR-1737 decision): the shim is a
// detector, not the root fix. Running it on every PR would double the component
// suite's cost and — because it re-orders the scheduler — any new failure it
// finds is likely in a file the PR never touched, red-lighting an innocent diff
// (exactly the tax the flaky-spec rule in CLAUDE.md exists to prevent). A
// nightly lane on `main` catches new instances against the branch that actually
// introduced them. The ROOT fix (`IS_REACT_ACT_ENVIRONMENT = true`, which
// removes the class rather than detecting it) is a ~30-file `act()`-warning
// migration of its own — tracked as its own card, see the PR body.
//
// Run locally: `pnpm test:late-effects`
const config = mergeConfig(baseConfig, defineConfig({}));

// ⚠️ ASSIGN, don't merge. `mergeConfig` CONCATENATES arrays and cannot blank an
// object value, so passing these in the merged object would UNION them with the
// base `include` (`tests/**/*.test.{ts,tsx}`) and run the entire 595-file suite
// under the shim — ~14 minutes, most of it Node integration files that render
// nothing. Overwrite after merging instead (the same trick
// vitest.collect.config.ts uses on `thresholds`).

// Only the browser-environment (happy-dom) files can carry this race — a Node
// integration test has no React render to order effects against.
config.test!.include = [
  'tests/components/**/*.test.tsx',
  'tests/hooks/**/*.test.ts',
  'tests/work-items/work-item-ref-chip.test.tsx',
  'tests/work-items/markdown-render.test.tsx',
];

// INSTRUMENT ARTIFACTS, not races — every one of these calls
// `vi.useFakeTimers()`, which replaces `setTimeout`, so the shim's deferral
// never fires: `appearance-sync` times out outright, and the two filter files
// still pass but take ~80× as long (157 s vs 2 s), which alone would triple the
// lane. Excluded deliberately; re-verify by hand if their timer usage changes.
config.test!.exclude = [
  'tests/components/appearance-sync.test.tsx',
  'tests/components/issue-filter-bar.test.tsx',
  'tests/components/advanced-filter.test.tsx',
];

config.test!.setupFiles = [
  './tests/helpers/perWorkerDb.ts',
  './tests/helpers/inngestSetup.ts',
  './tests/helpers/lateEffects.ts',
];

// The audit lane proves ORDERING, not coverage; the sharded `test` job and the
// `coverage` merge job own the thresholds.
config.test!.coverage!.thresholds = {};
config.test!.coverage!.enabled = false;

export default config;
