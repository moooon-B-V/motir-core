import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';
import { VITEST_LEG_IDS, filesForLeg } from './tests/helpers/vitestShardPlan';

// CI test-shard coverage COLLECTION config (MOTIR-1711). Identical to the base
// vitest.config.ts (same `include`, setupFiles, globalSetup, provider) EXCEPT
// the per-file thresholds are STRIPPED: each shard only exercises a subset of
// the gated files, so a per-shard threshold would fail on partial coverage.
// The `coverage` merge job enforces the thresholds on the MERGED report using
// the BASE config (`vitest --mergeReports --coverage`), not this one.
//
// `mergeConfig` deep-merges, so it cannot blank an object value -- strip
// `thresholds` after merging. `{}` = no per-file thresholds (verified: shards
// pass; the merge job re-imposes the real thresholds on the combined report).
const config = mergeConfig(baseConfig, defineConfig({}));
config.test!.coverage!.thresholds = {};

// MOTIR-3912 — narrow `include` to THIS leg's files when the CI matrix names
// one. `VITEST_LEG` replaces the `--shard=i/8` flag the job used to pass: the
// membership now comes from a cost-based bin-pack (tests/helpers/vitestShardPlan.ts)
// rather than from a contiguous slice of the alphabet, which is what put 19 of
// the suite's 30 most expensive files on a single leg.
//
// Unset — every local run, and the `coverage` merge job — leaves `include`
// exactly as the base config has it, so a developer's `pnpm test` is untouched.
//
// ⚠️ AN UNRECOGNISED VALUE THROWS RATHER THAN FALLING BACK. The quiet failure
// this replaces is a leg that runs FEWER files and still reports green: falling
// back to the full suite would instead make all eight legs run everything, which
// is 8x the work and equally invisible. Neither is acceptable, so a typo in the
// matrix stops the job.
const leg = process.env['VITEST_LEG'];
if (leg !== undefined && leg !== '') {
  const files = filesForLeg(leg);
  if (files === null) {
    throw new Error(
      `VITEST_LEG="${leg}" is not one of the plan's legs (${VITEST_LEG_IDS.join(', ')}). ` +
        'It comes from the `test` matrix in .github/workflows/ci.yml, which ' +
        '`tests/vitest-shard-plan.test.ts` cross-checks against the plan.',
    );
  }
  config.test!.include = files;
}

export default config;
