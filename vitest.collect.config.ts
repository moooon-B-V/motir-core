import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

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

export default config;
