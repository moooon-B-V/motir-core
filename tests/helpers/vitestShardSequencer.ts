import { relative } from 'node:path';
import { BaseSequencer } from 'vitest/node';
import type { TestSpecification } from 'vitest/node';
import { VITEST_LEG_IDS, assignLegs } from './vitestShardPlan';

/**
 * The cost-balanced replacement for Vitest's own `--shard` partition
 * (MOTIR-3912).
 *
 * Vitest calls `sequencer.shard()` — and ONLY when `--shard` is set — with every
 * spec it discovered, and takes whatever comes back as this shard's work. So the
 * CLI still passes `--shard=<leg>/8`; what changes is how the 1363 files are
 * divided, not that they are.
 *
 * ⚠️ WHY A SEQUENCER RATHER THAN NARROWING `include`, WHICH IS THE OBVIOUS MOVE
 * AND THE ONE THIS REPLACED. Handing the leg's 170 file paths to `test.include`
 * selects exactly the right tests and is ~7x SLOWER end to end, all of it after
 * the last test finishes. Measured on one 8ms test file with coverage on:
 * 20s with the single `tests/**` glob, 148s with a 170-path array; with coverage
 * OFF the two are 1s and 2s. In CI it cost every leg 567–1100s of post-test time
 * against a 55–97s baseline, which took the lane from ~10 min to 25–37 min while
 * every leg still reported green. The v8 coverage provider walks `include`
 * patterns when it builds the report, and 170 patterns is 170 walks of the tree.
 *
 * The sequencer has none of that shape: `include` stays one glob, coverage sees
 * what it always saw, and the partition happens on an in-memory array Vitest has
 * already discovered.
 *
 * It also makes totality EXACT rather than argued. The files packed are the ones
 * Vitest handed us, so "every discovered file lands on exactly one leg" is true
 * by construction — there is no second enumeration that could disagree with the
 * config's, which is the failure a narrowed `include` can hide (a leg that runs
 * fewer files still reports green).
 */
export default class CostBalancedSequencer extends BaseSequencer {
  override async shard(specs: TestSpecification[]): Promise<TestSpecification[]> {
    const { config } = this.ctx;
    const shard = config.shard;
    // `shard()` is only invoked when `config.shard` is set, so this is defensive
    // rather than a path we expect. Returning everything is the safe direction:
    // a leg that runs too much is slow, a leg that runs too little is silent.
    if (!shard) return specs;

    // A shard count this plan does not describe is NOT ours to divide — fall
    // back to Vitest's own partition rather than mapping onto the wrong number
    // of legs. `tests/vitest-shard-plan.test.ts` pins ci.yml's matrix to the
    // plan's length, so in CI this cannot silently take effect.
    if (shard.count !== VITEST_LEG_IDS.length) return super.shard(specs);

    const byPath = new Map<string, TestSpecification>();
    for (const spec of specs) {
      byPath.set(relative(config.root, spec.moduleId).split('\\').join('/'), spec);
    }
    const legId = VITEST_LEG_IDS[shard.index - 1];
    if (legId === undefined) return super.shard(specs);

    const assignment = assignLegs([...byPath.keys()]);
    return (assignment[legId] ?? []).flatMap((file) => {
      const spec = byPath.get(file);
      return spec ? [spec] : [];
    });
  }
}
