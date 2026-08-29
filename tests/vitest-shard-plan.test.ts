import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEST_SECONDS,
  FILE_TEST_SECONDS,
  VITEST_LEG_IDS,
  assignLegs,
  costSeconds,
  discoverTestFiles,
  legCostSeconds,
} from './helpers/vitestShardPlan';
import { STRUCTURAL_GUARD_SPECS } from './helpers/structuralGuardLane';

// MOTIR-3912 — the guard on the Vitest leg plan.
//
// ⚠️ THIS FILE IS IN `STRUCTURAL_GUARD_SPECS` ON PURPOSE, and that is the first
// thing to preserve about it. The lane it guards is the sharded suite; a guard
// that ran INSIDE that suite would be a guard the plan under test could assign
// to any leg — or, if the plan were broken in the precise way that matters, to
// none. It has to run somewhere the plan does not reach.
//
// WHAT IT IS FOR. Every failure this file catches is SILENT in CI: a leg that is
// handed fewer files than it should be still reports `Tests N passed` and still
// goes green. Nothing downstream compares the eight counts. So the properties
// below are the only thing standing between a bad split and a suite that
// quietly stops running part of itself.
//
// WHAT IT DELIBERATELY DOES NOT DO — see `tests/helpers/vitestShardPlan.ts`'s
// header — is require a measured cost for every file, the way
// `tests/e2e-shard-plan.test.ts` does for Playwright specs. That would fail
// every pull request that adds a test. Totality here comes from packing the
// DISCOVERED file list, not from the cost table's keys, and the third test below
// is what pins that difference down.

const CI_YML = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const VITEST_CONFIG = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8');

describe('the Vitest leg plan divides the suite exactly once (MOTIR-3912)', () => {
  it('reads the tree it is meant to guard', () => {
    // Without this, every assertion below passes vacuously on an empty glob —
    // which is precisely the shape of the bug they exist to catch.
    const files = discoverTestFiles();
    expect(files.length).toBeGreaterThan(1000);
    expect(VITEST_LEG_IDS.length).toBe(8);
    expect(files.every((f) => f.startsWith('tests/'))).toBe(true);
    // `STRUCTURAL_GUARD_SPECS` is `as const`, so its `includes` only accepts a
    // member of the literal union — widen to a Set of strings to ask the
    // question the other way round.
    const guards = new Set<string>(STRUCTURAL_GUARD_SPECS);
    expect(files.some((f) => guards.has(f))).toBe(false);
  });

  it('discovers exactly what the root config runs', () => {
    // The plan's glob and `vitest.config.ts`'s `include`/`exclude` are the same
    // statement made twice. A file the plan cannot see is a file no leg runs.
    expect(VITEST_CONFIG).toContain("include: ['tests/**/*.test.{ts,tsx}']");
    expect(VITEST_CONFIG).toContain('exclude: [...defaultExclude, ...STRUCTURAL_GUARD_SPECS]');
  });

  it('assigns every discovered file to exactly one leg', () => {
    const files = discoverTestFiles();
    const assignment = assignLegs();
    expect(Object.keys(assignment).sort()).toEqual([...VITEST_LEG_IDS].sort());
    const assigned = Object.values(assignment).flat();
    expect(new Set(assigned).size, 'no file is assigned twice').toBe(assigned.length);
    expect(assigned.sort()).toEqual([...files].sort());
  });

  it('gives an UNMEASURED file a leg — a new test must never fall through', () => {
    // The load-bearing difference from the Playwright plan. A file with no cost
    // entry is not an error and not a gap: it takes the default and runs. If
    // this ever fails, somebody has made membership depend on the cost table.
    const synthetic = 'tests/zzz-brand-new-unmeasured-file.test.ts';
    expect(FILE_TEST_SECONDS[synthetic]).toBeUndefined();
    expect(costSeconds(synthetic)).toBeCloseTo(DEFAULT_TEST_SECONDS + 1.92, 5);

    const withNew = [...discoverTestFiles(), synthetic];
    const assignment = assignLegs(withNew);
    const legs = VITEST_LEG_IDS.filter((id) => assignment[id]?.includes(synthetic));
    expect(legs, `${synthetic} landed on ${legs.length} legs`).toHaveLength(1);
    expect(Object.values(assignment).flat()).toHaveLength(withNew.length);
  });

  it('balances the legs to within 10% of the mean assumed cost', () => {
    const costs = VITEST_LEG_IDS.map(legCostSeconds);
    const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
    const spread = Math.max(...costs) - Math.min(...costs);
    expect(spread / mean, `leg costs: ${costs.map((c) => c.toFixed(0)).join(', ')}`).toBeLessThan(
      0.1,
    );
  });

  it('is deterministic — every leg computes the same assignment independently', () => {
    // All eight runners compute this separately. A packer that ordered files by
    // anything unstable would drop or double-run them with every leg still
    // green, which is the one failure mode no downstream check would notice.
    expect(assignLegs()).toEqual(assignLegs());
    const shuffled = [...discoverTestFiles()].reverse();
    expect(assignLegs(shuffled)).toEqual(assignLegs());
  });

  it('spreads the heaviest files across different legs', () => {
    // The symptom that motivated the card: 19 of the 30 most expensive files on
    // one leg. The eight heaviest must not share.
    const heaviest = Object.entries(FILE_TEST_SECONDS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([f]) => f);
    const assignment = assignLegs();
    const legs = heaviest.map((f) => VITEST_LEG_IDS.find((id) => assignment[id]?.includes(f)));
    expect(new Set(legs).size, `${heaviest.join(', ')} landed on ${legs.join(', ')}`).toBe(
      heaviest.length,
    );
  });

  it('has no cost entry for a file that no longer exists', () => {
    // Harmless to the split — an entry for a deleted file is never looked up —
    // but it rots the table's credibility as a record of what the suite costs,
    // and a rotting table is what stops anyone re-measuring from it.
    const files = new Set(discoverTestFiles());
    const stale = Object.keys(FILE_TEST_SECONDS).filter((f) => !files.has(f));
    expect(stale, 'delete the cost entry when the test file goes').toEqual([]);
  });

  it("matches ci.yml's `test` matrix leg ids", () => {
    // The matrix supplies VITEST_LEG. A leg id in one and not the other either
    // throws in vitest.collect.config.ts (an id the plan does not know) or
    // silently never runs its files (a leg the matrix does not launch).
    const matrix = /\n {8}leg: \[([^\]]+)\]/.exec(CI_YML);
    expect(matrix, 'ci.yml `test` job declares a `leg:` matrix').not.toBeNull();
    const ids = (matrix?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    expect(ids).toEqual([...VITEST_LEG_IDS]);
    // And the step must pass it, with a per-leg blob name — see the blob-file
    // collision note in the job's own comment.
    expect(CI_YML).toContain('VITEST_LEG: ${{ matrix.leg }}');
    expect(CI_YML).toContain('--outputFile.blob=.vitest-reports/blob-${{ matrix.leg }}.json');
    expect(CI_YML, 'the cost-based plan replaces --shard, it does not join it').not.toContain(
      '--shard=${{ matrix.leg }}',
    );
  });
});
