import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';
import CostBalancedSequencer from './tests/helpers/vitestShardSequencer';

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

// MOTIR-3912 — divide the suite across the CI legs by MEASURED COST rather than
// by Vitest's own `--shard` partition. The CLI still passes `--shard=<leg>/8`;
// `CostBalancedSequencer.shard()` is what Vitest calls with the discovered
// specs, and it returns this leg's bin-packed subset instead of Vitest's slice.
//
// ⚠️ THE OBVIOUS ALTERNATIVE — narrowing `test.include` to the leg's 170 file
// paths — WORKS AND IS A SEVERE PERFORMANCE BUG. See the sequencer's header for
// the measurements (20s → 148s on a single 8ms test locally; 567–1100s of
// post-test time per leg in CI against a 55–97s baseline, with every leg still
// green). Do not "simplify" this back into an `include` list.
//
// Nothing here fires for a local `pnpm test`: `shard()` runs only when `--shard`
// is passed, so a developer's run is untouched by the plan.
config.test!.sequence = { ...(config.test!.sequence ?? {}), sequencer: CostBalancedSequencer };

export default config;
