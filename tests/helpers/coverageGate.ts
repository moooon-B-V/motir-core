import { createRequire } from 'node:module';
import { coverageConfigDefaults } from 'vitest/config';

import baseConfig from '../../vitest.config';

/**
 * Read `vitest.config.ts`'s coverage gate the way the COVERAGE PROVIDER reads
 * it — same matcher, same options — so a guard can ask "would this pattern
 * actually resolve to a file in the report?" instead of reasoning about globs.
 *
 * Why this exists (MOTIR-2449): a Next.js route group is a literal
 * `(authed)` directory on disk, but `(` is grouping syntax to picomatch. Twenty
 * `coverage.include` entries and twenty `coverage.thresholds` keys were written
 * as the literal `app/(authed)/…` path, which the provider's own matcher
 * resolves to NOTHING — so those files never entered a coverage report and
 * their ≥90% thresholds were inert. An unmatched threshold key is not an error
 * in Vitest (`resolveThresholds` simply builds an empty coverage map for it),
 * so the failure was silent and looked exactly like a pass.
 *
 * The two matchers below are resolved THROUGH vitest's own `node_modules`
 * rather than declared as our dependencies: a guard that matched with a
 * different picomatch than the provider uses would be a second source of truth,
 * and the whole point is to be the same one.
 */

type Matcher = (input: string) => boolean;

interface Picomatch {
  (glob: string | string[], options?: Record<string, unknown>): Matcher;
  isMatch(input: string, glob: string | string[], options?: Record<string, unknown>): boolean;
}

const requireHere = createRequire(import.meta.url);
const requireFromVitest = createRequire(requireHere.resolve('vitest'));
const pm = requireFromVitest('picomatch') as Picomatch;
const { glob } = requireFromVitest('tinyglobby') as {
  glob: (patterns: string[], options: Record<string, unknown>) => Promise<string[]>;
};

/** The threshold keys Vitest reserves for the GLOBAL gate, not per-file globs. */
const RESERVED_THRESHOLD_KEYS = new Set([
  'perFile',
  'autoUpdate',
  '100',
  'lines',
  'functions',
  'statements',
  'branches',
]);

interface CoverageOptions {
  include?: string[];
  exclude?: string[];
  thresholds?: Record<string, unknown>;
}

const coverage = (baseConfig.test?.coverage ?? {}) as CoverageOptions;

export const includePatterns: string[] = coverage.include ?? ['**'];
export const excludePatterns: string[] = coverage.exclude ?? [...coverageConfigDefaults.exclude];
export const thresholdKeys: string[] = Object.keys(coverage.thresholds ?? {}).filter(
  (key) => !RESERVED_THRESHOLD_KEYS.has(key),
);

const root = process.cwd();

/**
 * Mirrors `BaseCoverageProvider.isIncluded` — the check every TESTED file goes
 * through. Note the two options that make it differ from a plain glob match:
 * the filename is ABSOLUTE and `contains: true` is set.
 */
function isIncluded(relativePath: string): boolean {
  return pm.isMatch(`${root}/${relativePath}`, includePatterns, {
    contains: true,
    dot: true,
    ignore: excludePatterns,
  });
}

let cached: Promise<string[]> | undefined;

/**
 * Every file the coverage report can contain: what `coverage.include` resolves
 * to on disk (the provider's `getUntestedFilesByRoot` glob), narrowed by the
 * `isIncluded` pass the provider runs afterwards. A file outside this set can
 * never carry a per-file threshold, however plausible its path looks.
 */
export function reportableFiles(): Promise<string[]> {
  cached ??= glob(includePatterns, {
    cwd: root,
    ignore: excludePatterns,
    absolute: false,
    dot: true,
    onlyFiles: true,
  }).then((files) => files.filter(isIncluded).sort());
  return cached;
}

/**
 * The reportable files an `include` pattern resolves to — matched the way the
 * provider matches, against the ABSOLUTE path with `contains: true`. Matching
 * the relative path instead would be a different (looser) question, and one
 * that answers `true` for the very route-group paths that reach no file.
 */
export async function filesForIncludePattern(pattern: string): Promise<string[]> {
  return (await reportableFiles()).filter((file) =>
    pm.isMatch(`${root}/${file}`, pattern, { contains: true, dot: true }),
  );
}

/**
 * The reportable files a THRESHOLD key gates. Mirrors
 * `BaseCoverageProvider.resolveThresholds`, which matches a plain `pm(glob)`
 * against each covered file's path relative to the config root.
 */
export async function filesForThresholdKey(key: string): Promise<string[]> {
  const match = pm(key);
  return (await reportableFiles()).filter((file) => match(file));
}

/** The per-file thresholds that apply to `file`, keyed by the glob that gates it. */
export async function thresholdsFor(file: string): Promise<Record<string, Record<string, number>>> {
  const thresholds = (coverage.thresholds ?? {}) as Record<string, Record<string, number>>;
  const applied: Record<string, Record<string, number>> = {};
  for (const key of thresholdKeys) {
    if ((await filesForThresholdKey(key)).includes(file)) applied[key] = thresholds[key]!;
  }
  return applied;
}
