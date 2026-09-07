import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { REPO_ROOT, specifiersOf } from './helpers/importGraph';

// MOTIR-4751 — the ACCEPTANCE-LANE IMPORT DIRECTION guard.
//
// ── The defect ──────────────────────────────────────────────────────────────
// `tests/e2e/_helpers/promoted-regression.ts` and
// `tests/e2e/_helpers/acceptance-video.ts` export the SAME three fixture names
// with the SAME signatures, deliberately: promoting a spec out of the
// acceptance lane (MOTIR-2769) is then a one-line import swap rather than a
// hand-edit of ~260 `chapter()` and `beat()` calls, and an import swap cannot
// drop an assertion. That property is worth keeping and this guard does not
// touch it.
//
// What it costs is that the two modules are INTERCHANGEABLE TO EVERY OTHER
// CHECK. A spec that is still in the acceptance lane and imports the shim by
// mistake type-checks, lints, and passes — and silently records nothing:
// `acceptanceStory()` is a no-op so no `acceptance-story.json` is written,
// `beat()` is a no-op so the clip runs at machine speed, and `chapter()` keeps
// the `test.step` while dropping both the hold and the `chapters.json` sidecar
// the publish call reads. The spec goes green, the lane goes green, and the
// output directory holds a video with no chapters and no story. Measured on
// 2026-09-06: an acceptance spec written against the shim passed `4 passed
// (2.5m)` with `video.webm` and `trace.zip` and nothing else; swapping ONLY the
// import produced `chapters.json`, `acceptance-story.json`,
// `recording-meta.json` and `contention.json` beside the same clip.
//
// The reverse mistake is the one that had already shipped, and it is the reason
// this guard asserts BOTH directions rather than the one the bug was filed
// about. `tests/e2e/provenance.spec.ts` (MOTIR-1685) has imported
// `_helpers/acceptance-video` since it was written, while its filename has
// never matched this lane's `testMatch` — so it ran in the BULK lane on every
// pull request, paying four `CHAPTER_HOLD_MS` holds (~10 s of its recorded
// 15.2 s), writing three sidecars nothing reads, and declaring
// `acceptanceStory('MOTIR-1685')` for a receipt it cannot publish. Its own
// header said it ran under `playwright.acceptance.config.ts`, which was the
// only place that claim was ever recorded and was never true. This guard is
// what turns that from a sentence somebody has to read into a red check.
//
// ── Why here, and not in eslint ─────────────────────────────────────────────
// `no-restricted-imports` is where a rule of this shape usually goes, and it
// cannot hold this one: lane membership is decided by
// `playwright.acceptance.config.ts`'s `testMatch`, so an eslint override would
// have to COPY that glob into `eslint.config.mjs` — a second home for the
// authority, drifting silently the moment the config changes. This guard READS
// the glob from the config that owns it, which is the same reasoning
// `tests/ci-structural-guards-lane.test.ts` derives its membership by rather
// than listing it.
//
// ── The lane ────────────────────────────────────────────────────────────────
// It parses text, opens no database and imports only `node:fs` / `node:path`
// and `tests/helpers/importGraph` (which imports neither), so it carries no
// coverage into the merged report and belongs in the structural-guard lane. It
// does its own walk rather than importing a scanner, so nothing DERIVES it —
// hence the entry in `SELF_WALKING_MEMBERS` beside its lane membership.

/** The Playwright config that OWNS the lane's membership. Read, never copied. */
const ACCEPTANCE_CONFIG = 'playwright.acceptance.config.ts';

/** The two modules, repo-relative and extension-less — the axis under test. */
const RECORDING_MODULE = 'tests/e2e/_helpers/acceptance-video';
const PROMOTED_MODULE = 'tests/e2e/_helpers/promoted-regression';

/**
 * The lane's own declaration, read out of its config.
 *
 * Parsed from the COMMENT-STRIPPED text: that file's header discusses
 * `acceptance*.spec.ts` in prose several times, so a regex over the raw source
 * can match a sentence about the glob instead of the glob.
 */
export function laneDeclarationIn(configSource: string): {
  testDir: string;
  testMatch: string[];
} {
  const code = configSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
  const dir = /\btestDir:\s*'([^']+)'/.exec(code);
  const match = /\btestMatch:\s*\[([^\]]*)\]/.exec(code);
  return {
    testDir: dir?.[1] ?? '',
    testMatch: [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    ),
  };
}

/**
 * One glob → one anchored RegExp over a path RELATIVE TO `testDir`, which is
 * what Playwright matches `testMatch` against. `**` spans directory
 * separators, `*` does not.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === '*' && glob[i + 1] === '*') {
      // `**/` matches zero or more directories; a bare `**` matches anything.
      if (glob[i + 2] === '/') {
        out += '(?:[^/]*\\/)*';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Every runtime import of `file`, normalised to a repo-relative module path. */
function importedModules(file: string, source: string): string[] {
  const dir = posix.dirname(file);
  return specifiersOf(source).flatMap((specifier) => {
    if (!specifier.startsWith('.')) return [];
    return [posix.normalize(posix.join(dir, specifier)).replace(/\.(?:ts|tsx|js|mjs)$/, '')];
  });
}

export interface LaneImportViolation {
  file: string;
  imported: string;
  shouldHaveUsed: string;
  why: string;
}

export interface LaneImportVerdict {
  inLane: string[];
  outsideLane: string[];
  violations: LaneImportViolation[];
}

/**
 * The whole predicate, as a PURE function over a spec list and a reader — so
 * the synthetic cases at the bottom of this file drive the identical code over
 * a tree that does not exist on disk. A proof that re-implements the predicate
 * proves the proof works, not the predicate (the reasoning
 * `tests/ci-structural-guards-lane.test.ts` splits its derivation out for).
 */
export function classifyLaneImports(
  specs: readonly string[],
  read: (file: string) => string,
  { testDir, testMatch }: { testDir: string; testMatch: readonly string[] },
): LaneImportVerdict {
  const patterns = testMatch.map(globToRegExp);
  const isInLane = (file: string) => {
    const rel = posix.relative(testDir, file);
    return patterns.some((pattern) => pattern.test(rel));
  };

  const inLane: string[] = [];
  const outsideLane: string[] = [];
  const violations: LaneImportViolation[] = [];

  for (const file of specs) {
    const lane = isInLane(file);
    (lane ? inLane : outsideLane).push(file);

    const imports = importedModules(file, read(file));
    if (lane && imports.includes(PROMOTED_MODULE)) {
      violations.push({
        file,
        imported: PROMOTED_MODULE,
        shouldHaveUsed: RECORDING_MODULE,
        why: 'it is IN the acceptance lane, and the shim records nothing — no chapters.json, no acceptance-story.json, no recording-meta.json, so the run produces a clip that cannot be published as a receipt',
      });
    }
    if (!lane && imports.includes(RECORDING_MODULE)) {
      violations.push({
        file,
        imported: RECORDING_MODULE,
        shouldHaveUsed: PROMOTED_MODULE,
        why: 'it is OUTSIDE the acceptance lane, and the recording apparatus holds CHAPTER_HOLD_MS after every chapter, writes sidecars nothing reads, and declares a story whose receipt is frozen',
      });
    }
  }

  return { inLane, outsideLane, violations };
}

/** Every `*.spec.ts` under `dir`, repo-relative with forward slashes. */
function specsUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(REPO_ROOT, dir)).sort()) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(REPO_ROOT, rel)).isDirectory()) specsUnder(rel, out);
    else if (entry.endsWith('.spec.ts')) out.push(rel);
  }
  return out;
}

const describeViolation = (v: LaneImportViolation) =>
  `${v.file} imports ${v.imported} — use ${v.shouldHaveUsed}: ${v.why}`;

const DECLARATION = laneDeclarationIn(readFileSync(join(REPO_ROOT, ACCEPTANCE_CONFIG), 'utf8'));

describe('a spec imports the fixture module its LANE needs (MOTIR-4751)', () => {
  it('reads the lane declaration from the config that owns it — nothing here is a copy', () => {
    // Everything below is decided by these two values, so a parse that has
    // quietly stopped matching would make every assertion vacuous rather than
    // wrong. The config is the authority; this is the read of it.
    expect(DECLARATION.testDir, `${ACCEPTANCE_CONFIG} declares no testDir`).not.toBe('');
    expect(
      DECLARATION.testMatch,
      `${ACCEPTANCE_CONFIG} declares no testMatch — has the shape moved?`,
    ).not.toEqual([]);
    // Relative to `testDir`, which is what Playwright matches against.
    expect(
      DECLARATION.testMatch.some((glob) =>
        globToRegExp(glob).test('acceptance-legal-manifest.spec.ts'),
      ),
    ).toBe(true);
  });

  const specs = specsUnder(DECLARATION.testDir);
  const verdict = classifyLaneImports(specs, (f) => readFileSync(join(REPO_ROOT, f), 'utf8'), {
    testDir: DECLARATION.testDir,
    testMatch: DECLARATION.testMatch,
  });

  it('finds specs on BOTH sides of the lane — neither ruling is over an empty set', () => {
    // The MOTIR-2815 trap: a totality test whose population is empty passes
    // for ever, and the two populations here fail independently — a glob that
    // matched everything would empty `outsideLane`, one that matched nothing
    // would empty `inLane`, and either reads as green.
    expect(verdict.inLane.length, 'no spec matches the acceptance lane').toBeGreaterThan(0);
    expect(verdict.outsideLane.length, 'every spec matches the acceptance lane').toBeGreaterThan(
      20,
    );
  });

  it('no spec IN the lane imports the promoted shim — it would record nothing', () => {
    expect(
      verdict.violations.filter((v) => v.imported === PROMOTED_MODULE).map(describeViolation),
    ).toEqual([]);
  });

  it('no spec OUTSIDE the lane imports the recording apparatus — it would hold, and publish nowhere', () => {
    expect(
      verdict.violations.filter((v) => v.imported === RECORDING_MODULE).map(describeViolation),
    ).toEqual([]);
  });
});

// ── The predicate, DEMONSTRATED ─────────────────────────────────────────────
//
// The assertions above rule on THIS tree, and a predicate that has quietly
// stopped matching passes every one of them — the shape
// `tests/ci-structural-guards-lane.test.ts` and
// `tests/theme/modalScrollContainer.test.ts` both answer by driving the real
// classifier over a synthetic tree. Both directions are proved RED, and each
// one's own control is proved GREEN: a guard that only ever fires proves as
// little as one that never does.
describe('fires in BOTH directions — demonstrated, not assumed', () => {
  const DECL = { testDir: 'tests/e2e', testMatch: ['**/acceptance*.spec.ts'] };
  const RECORDING_SPEC = ["import { test, expect } from './_helpers/acceptance-video';"].join('\n');
  const PROMOTED_SPEC = ["import { test, expect } from './_helpers/promoted-regression';"].join(
    '\n',
  );

  const classify = (file: string, source: string) =>
    classifyLaneImports([file], () => source, DECL);

  it('RED: an acceptance spec that imports the promoted shim', () => {
    const { violations, inLane } = classify('tests/e2e/acceptance-widget.spec.ts', PROMOTED_SPEC);
    expect(inLane).toEqual(['tests/e2e/acceptance-widget.spec.ts']);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.imported).toBe(PROMOTED_MODULE);
    expect(violations[0]?.shouldHaveUsed).toBe(RECORDING_MODULE);
  });

  it('RED: a promoted spec that keeps the recording apparatus', () => {
    const { violations, outsideLane } = classify('tests/e2e/widget.spec.ts', RECORDING_SPEC);
    expect(outsideLane).toEqual(['tests/e2e/widget.spec.ts']);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.imported).toBe(RECORDING_MODULE);
    expect(violations[0]?.shouldHaveUsed).toBe(PROMOTED_MODULE);
  });

  it('GREEN: the same two specs with the imports the other way round', () => {
    expect(classify('tests/e2e/acceptance-widget.spec.ts', RECORDING_SPEC).violations).toEqual([]);
    expect(classify('tests/e2e/widget.spec.ts', PROMOTED_SPEC).violations).toEqual([]);
  });

  it('reads the IMPORT, not the prose — a comment naming the module is not one', () => {
    // Every promoted spec in this tree carries a header sentence about the
    // acceptance lane, so a substring predicate would report the whole
    // population and the guard would be un-shippable on its first run.
    const commented = [
      '// Promoted out of the acceptance lane: the `_helpers/acceptance-video`',
      '// apparatus is gone; see docs for what a promotion keeps.',
      "import { test, expect } from './_helpers/promoted-regression';",
    ].join('\n');
    expect(classify('tests/e2e/widget.spec.ts', commented).violations).toEqual([]);
  });

  it('reads a RUNTIME import — a type-only one is erased and records nothing', () => {
    const typeOnly = [
      "import type { Chapter } from './_helpers/acceptance-video';",
      "import { test, expect } from './_helpers/promoted-regression';",
    ].join('\n');
    expect(classify('tests/e2e/widget.spec.ts', typeOnly).violations).toEqual([]);
  });

  it('the glob decides membership, not the filename — a changed testMatch moves the line', () => {
    // The property the READ buys: point `testMatch` somewhere else and the same
    // file changes sides, with no edit here. A copied glob could not do this.
    const moved = { testDir: 'tests/e2e', testMatch: ['**/receipt-*.spec.ts'] };
    expect(
      classifyLaneImports(['tests/e2e/receipt-widget.spec.ts'], () => PROMOTED_SPEC, moved)
        .violations,
    ).toHaveLength(1);
    expect(
      classifyLaneImports(['tests/e2e/acceptance-widget.spec.ts'], () => PROMOTED_SPEC, moved)
        .violations,
    ).toEqual([]);
  });

  it('`**/` spans directories and `*` does not — the glob translation, checked', () => {
    const pattern = globToRegExp('**/acceptance*.spec.ts');
    expect(pattern.test('acceptance-widget.spec.ts')).toBe(true);
    expect(pattern.test('nested/acceptance-widget.spec.ts')).toBe(true);
    expect(pattern.test('acceptance/nested.spec.ts')).toBe(false);
    expect(pattern.test('widget.spec.ts')).toBe(false);
    // A literal dot is a dot, not "any character".
    expect(pattern.test('acceptance-widgetXspec.ts')).toBe(false);
  });
});
