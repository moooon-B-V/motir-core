import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { globToRegExp, laneDeclarationIn } from './helpers/playwrightLane';

// MOTIR-4830 — every spec in the CLOUD-ON lane resets the database it shares.
//
// ── The defect ──────────────────────────────────────────────────────────────
// `playwright.cloud.config.ts` sets `retries: process.env['CI'] ? 1 : 0`, and a
// retry re-runs the test body in a NEW worker against the SAME database: nothing
// truncates in between except an explicit `resetDatabase()`. A spec that seeds a
// user at a hard-coded literal email therefore cannot get past its first line on
// attempt 2 — it throws `DuplicateEmailError` in the seed, before a single
// assertion runs.
//
// That is worse than a wasted retry, because the failing job's summary shows the
// LAST attempt: the visible cause of the failure becomes a seeding collision that
// has nothing to do with why the test failed. Observed on run 34124833957, where
// `cloud-agent-runs.spec.ts >> nothing has run yet reads as a fact, not an error`
// carried TWO error contexts — attempt 1 the real strict-mode defect
// (MOTIR-4822), attempt 2 the collision that overwrote it in the report.
//
// ── Why a guard and not three edits ─────────────────────────────────────────
// Twenty-four of the lane's twenty-seven specs already carried the reset and were
// correct; three did not. Nothing anywhere stated that the twenty-four were
// following a rule, so the omission was invisible in any single file and could
// only be seen by COUNTING — and the next spec added to the lane had a one-in-nine
// chance of being the fourth. The edits fix today's three; this is what makes the
// count stop mattering.
//
// ── What it asserts, and what it deliberately does not ──────────────────────
// The predicate is FILE-LEVEL: the spec reaches `resetDatabase` somewhere in its
// own code. That is a floor rather than a proof — a file that resets inside one
// test body leaves its siblings sharing state — and it is the right floor here,
// because the lane's members legitimately reset in three different places
// (`test.beforeEach`, `test.beforeAll`, and inside a test that seeds its own
// world), so a predicate keyed on the HOOK would fail correct code. What the
// floor buys is the case that actually occurred: a spec that resets NOWHERE.
//
// ── Lane ────────────────────────────────────────────────────────────────────
// Like its sibling `tests/e2e-truncate-retry.test.ts`, this stays in the sharded
// run rather than joining `STRUCTURAL_GUARD_SPECS`: it walks ONE directory
// (`tests/e2e`) rather than the source tree, so it is not the whole-tree profile
// that lane exists to move.

const REPO_ROOT = join(__dirname, '..');

/** The Playwright config that OWNS the lane's membership. Read, never copied. */
const CLOUD_CONFIG = 'playwright.cloud.config.ts';

/** The door every reset in this tree goes through (`tests/e2e-truncate-retry.test.ts`). */
const RESET = 'resetDatabase';

export interface LaneExemption {
  /** The spec, repo-relative — exactly as the walk below names it. */
  spec: string;
  /** Why this file may share state across attempts. Inline, and load-bearing. */
  why: string;
}

// ── The exemption list — EMPTY, and it only ever shrinks ────────────────────
//
// A spec belongs here only when it genuinely needs state to SURVIVE between its
// own tests, and it then owes the other remedy instead: a seed identity unique
// per attempt (a `Date.now()` suffix on the email and on every other unique key
// it writes), so attempt 2 collides with nothing. Saying that here is the whole
// point — the lane's isolation convention was an unwritten habit until this
// guard, and an exemption with no reason recreates exactly that.
//
// Both assertions below stay tight against this list: an entry naming a file
// that has left the lane, or one that has since started resetting, fails the
// suite rather than sitting here describing a tree that has moved on.
const KNOWN_SHARED_STATE: LaneExemption[] = [];

export interface LaneIsolationVerdict {
  /** Every spec the config's `testMatch` selects, repo-relative. */
  inLane: string[];
  /** Specs under `testDir` the config does NOT run — the control population. */
  outsideLane: string[];
  /** In-lane specs that reach `resetDatabase` nowhere. */
  offenders: string[];
}

/**
 * Comments are stripped before anything is matched, and import statements are
 * blanked. A spec's header discussing the reset is not the spec calling it, and
 * importing the name is not issuing it — the same two reads
 * `tests/e2e-truncate-retry.test.ts` had to make for the same reason.
 */
export function reachesReset(source: string): boolean {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1')
    .replace(/^import[\s\S]*?from\s+'[^']+';/gm, (m) => ' '.repeat(m.length));
  return new RegExp(`\\b${RESET}\\b`).test(code);
}

/**
 * The whole predicate, as a PURE function over a spec list and a reader — so the
 * synthetic cases at the bottom of this file drive the identical code over a tree
 * that does not exist on disk. A proof that re-implements the predicate proves
 * the proof works, not the predicate.
 */
export function classifyLaneIsolation(
  specs: readonly string[],
  read: (file: string) => string,
  { testDir, testMatch }: { testDir: string; testMatch: readonly string[] },
): LaneIsolationVerdict {
  const patterns = testMatch.map(globToRegExp);
  const inLane: string[] = [];
  const outsideLane: string[] = [];
  const offenders: string[] = [];

  for (const spec of specs) {
    const rel = posix.relative(testDir, spec);
    if (!patterns.some((pattern) => pattern.test(rel))) {
      outsideLane.push(spec);
      continue;
    }
    inLane.push(spec);
    if (!reachesReset(read(spec))) offenders.push(spec);
  }

  return { inLane, outsideLane, offenders };
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

const DECLARATION = laneDeclarationIn(readFileSync(join(REPO_ROOT, CLOUD_CONFIG), 'utf8'));

describe('every cloud-lane spec resets the database it shares (MOTIR-4830)', () => {
  it('reads the lane declaration from the config that owns it — nothing here is a copy', () => {
    // Everything below is decided by these two values, so a parse that has
    // quietly stopped matching would make every assertion vacuous rather than
    // wrong. The config is the authority; this is the read of it.
    expect(DECLARATION.testDir, `${CLOUD_CONFIG} declares no testDir`).not.toBe('');
    expect(
      DECLARATION.testMatch,
      `${CLOUD_CONFIG} declares no testMatch — has the shape moved?`,
    ).not.toEqual([]);
    // Relative to `testDir`, which is what Playwright matches against.
    expect(
      DECLARATION.testMatch.some((glob) => globToRegExp(glob).test('cloud-agent-runs.spec.ts')),
    ).toBe(true);
  });

  const specs = specsUnder(DECLARATION.testDir);
  const verdict = classifyLaneIsolation(
    specs,
    (f) => readFileSync(join(REPO_ROOT, f), 'utf8'),
    DECLARATION,
  );

  it('finds specs on BOTH sides of the lane — neither ruling is over an empty set', () => {
    // A totality test whose population is empty passes for ever, and the two
    // populations fail independently: a glob that matched everything would empty
    // `outsideLane`, one that matched nothing would empty `inLane`, and either
    // reads as green.
    expect(verdict.inLane.length, `no spec matches ${CLOUD_CONFIG}`).toBeGreaterThan(20);
    expect(
      verdict.outsideLane.length,
      `every spec under ${DECLARATION.testDir} matches ${CLOUD_CONFIG}`,
    ).toBeGreaterThan(20);
  });

  it(`no cloud-lane spec reaches ${RESET} nowhere`, () => {
    const listed = new Set(KNOWN_SHARED_STATE.map((e) => e.spec));
    const unlisted = verdict.offenders.filter((spec) => !listed.has(spec));

    expect(
      unlisted,
      `These specs run in the cloud lane, which retries once in CI against the SAME database, ` +
        `and they truncate nothing between attempts. A seed that writes a fixed identity — an ` +
        `email, a project key — then throws in attempt 2's setup, and that error REPLACES the ` +
        `real failure in the report a person opens.\n\n` +
        `Add the lane's own \`test.beforeEach(async () => { await ${RESET}(); })\` (the idiom in ` +
        `\`tests/e2e/cloud-video.spec.ts\`). If the file genuinely needs state to survive between ` +
        `its own tests, make its seed identity unique per attempt instead and record it in ` +
        `\`KNOWN_SHARED_STATE\` with the reason.\n\n${unlisted.join('\n')}`,
    ).toEqual([]);
  });

  it('carries no KNOWN_SHARED_STATE entry that has stopped applying — the list only shrinks', () => {
    const offending = new Set(verdict.offenders);
    const inLane = new Set(verdict.inLane);
    const stale = KNOWN_SHARED_STATE.filter((e) => !offending.has(e.spec)).map((e) =>
      inLane.has(e.spec)
        ? `${e.spec} — it now reaches ${RESET}; the exemption is spent`
        : `${e.spec} — it is not in the lane at all (renamed, moved or deleted)`,
    );

    expect(
      stale,
      'These entries no longer describe the tree. Delete them — an exemption that has stopped ' +
        'applying is what turns a tight list back into a stale one.',
    ).toEqual([]);
  });

  it('every exemption states a REASON, not just a path', () => {
    for (const entry of KNOWN_SHARED_STATE) {
      expect(entry.why.length, `${entry.spec} carries no reason`).toBeGreaterThan(40);
    }
  });
});

// ── The predicate, DEMONSTRATED ─────────────────────────────────────────────
//
// The assertions above rule on THIS tree, and a predicate that has quietly
// stopped matching passes every one of them. Both directions are proved — a
// spec with no reset is caught, and its own control with the reset is not —
// because a guard that only ever fires proves as little as one that never does.
describe('fires on a spec that resets nowhere — demonstrated, not assumed', () => {
  const DECL = {
    testDir: 'tests/e2e',
    testMatch: ['**/billing-cloud.spec.ts', '**/cloud-*.spec.ts'],
  };
  const TREE: Record<string, string> = {
    // In the lane, resets in the lane's own idiom — the control.
    'tests/e2e/cloud-good.spec.ts': [
      "import { resetDatabase } from './_helpers/db-reset';",
      'test.beforeEach(async () => {',
      '  await resetDatabase();',
      '});',
    ].join('\n'),
    // In the lane, resets nowhere — the defect.
    'tests/e2e/cloud-bad.spec.ts': [
      "import { seedScopedRun } from './_helpers/scoped-run-seed';",
      "test('x', async () => { await seedScopedRun('fixed@example.com', 'K'); });",
    ].join('\n'),
    // In the lane, and only TALKS about the reset — prose is not compliance.
    'tests/e2e/cloud-prose.spec.ts': [
      '// This spec deliberately does not call resetDatabase(); see below.',
      '/* resetDatabase is called by its neighbours. */',
      "test('x', async () => {});",
    ].join('\n'),
    // In the lane, and only IMPORTS the name — importing is not issuing.
    'tests/e2e/cloud-imports.spec.ts': [
      "import { resetDatabase } from './_helpers/db-reset';",
      "test('x', async () => {});",
    ].join('\n'),
    // Outside the lane, resets nowhere — the main lane truncates per test and is
    // not this guard's business. It is here to prove the glob still excludes.
    'tests/e2e/board-flow.spec.ts': "test('x', async () => {});",
  };
  const verdict = classifyLaneIsolation(Object.keys(TREE), (f) => TREE[f]!, DECL);

  it('rules only on the specs the config actually runs', () => {
    expect(verdict.outsideLane).toEqual(['tests/e2e/board-flow.spec.ts']);
    expect(verdict.inLane).toHaveLength(4);
  });

  it('catches the spec that resets nowhere, and clears the one that does', () => {
    expect(verdict.offenders).toEqual([
      'tests/e2e/cloud-bad.spec.ts',
      'tests/e2e/cloud-prose.spec.ts',
      'tests/e2e/cloud-imports.spec.ts',
    ]);
  });

  it('reads neither a comment nor an import as a reset', () => {
    expect(reachesReset('// resetDatabase() runs in the sibling')).toBe(false);
    expect(reachesReset("import { resetDatabase } from './_helpers/db-reset';")).toBe(false);
    expect(reachesReset('await resetDatabase();')).toBe(true);
  });
});
