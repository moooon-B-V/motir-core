import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DATABASE_RESET_CALLS,
  loopedDatabaseResetTests,
  stripCommentsAndStrings,
} from './helpers/timeoutBudget';

// MOTIR-4089 — a test that resets the database ONCE PER ROUND declares its own
// budget, and this asks the whole tree rather than one file.
//
// ── The failure this exists to end ──────────────────────────────────────────
// MOTIR-3167 wrote the budget guard, MOTIR-3736 carried it to
// `tests/planning/planTargetLockService.test.ts`, and both wrote it as a test
// that reads its OWN source: "the budget belongs to the FILE, so the file reads
// itself." That is right about where a budget belongs and it settles nothing
// about the file next door.
//
// The target-lock pair is what proved it. MOTIR-3736 measured and budgeted the
// SERVICE half; its sibling `tests/integration/planning/planningTargetLockGate.
// test.ts` runs the same five-round race through the SHIPPED route and the jobs
// engine — the heavier of the two by construction — and the guard could not see
// it, so it stayed on `vitest.config.ts`'s 15 s default. It then timed out on
// `Vitest (7/12)` on two unrelated pull requests four days apart (#2494 run
// 33492578435, #2496 run 33504795817), each time on a diff that touches no file
// in the lock graph.
//
// A per-file guard cannot end a per-file omission, and the third file in the
// class would have repeated the conversation. So the question moves to the tree.
//
// ── Why THIS predicate, and not "every database test declares a budget" ─────
// About 870 files under `tests/` reach a truncate helper. Asking all of them for
// a budget is a different and much larger change, and one with no evidence
// behind it: an ordinary real-Postgres case here measures 97–459 ms and fits
// inside 15 s with two orders of magnitude to spare.
//
// The population that CANNOT is the one that resets per ROUND. A truncate is
// `AccessExclusiveLock` on the whole table set, so a loop of them is lock-wait
// bound rather than CPU bound — the one axis that goes non-linear under
// contention, which is why both offenders degraded ~2.4–2.9x against their own
// sibling shards in the same minute while the median shard moved barely at all.
// That is a narrow, decidable, evidence-backed predicate, and on `origin/main`
// it names exactly two tests.
//
// ── Why a source scan ───────────────────────────────────────────────────────
// There is no runtime object to assert on: a budget is an argument at a call
// site, and the failure mode is that the NEXT such test is written without one.
// Same instrument, and the same reasoning, as `tests/e2e-truncate-retry.test.ts`
// one directory over.
//
// ── Lane ────────────────────────────────────────────────────────────────────
// This walks all of `tests/` and reads every file in it, so it is a whole-tree
// guard and belongs in `STRUCTURAL_GUARD_SPECS` — where it is listed, and named
// in that file's `SELF_WALKING_MEMBERS` because it does its own `readdirSync`
// and nothing derives it. It opens no database and imports nothing from `lib/`,
// `app/` or `components/`, so it carries no coverage out of the merged report.

const ROOT = join(__dirname, '..');
const TESTS_DIR = join(ROOT, 'tests');

function testFiles(dir = TESTS_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(relative(ROOT, path).split(sep).join('/'));
  }
  return out;
}

describe('a per-round database reset declares its own budget (MOTIR-4089)', () => {
  const FILES = testFiles();

  it('the scan sees the test tree at all', () => {
    // A source-scanning guard whose walk has quietly gone empty passes every
    // assertion below and reads exactly like a clean repository. The floor is
    // the way that failure stays loud.
    expect(FILES.length).toBeGreaterThan(1000);
    expect(FILES).toContain('tests/integration/planning/planningTargetLockGate.test.ts');
    expect(FILES).toContain('tests/planning/planTargetLockService.test.ts');
  });

  it('the detector fires on the shape, and not on its neighbours — demonstrated, not assumed', () => {
    // Every case below is one this repository actually contains, which is what
    // makes them worth pinning: each is a way the scan could report the wrong
    // answer while still looking like it works.

    // POSITIVE — the shape itself: a reset inside the loop, no budget.
    const offender = [
      "it('races five rounds', async () => {",
      '  for (let round = 0; round < 5; round += 1) {',
      '    await truncateAuthTables();',
      '  }',
      '});',
    ].join('\n');
    expect(loopedDatabaseResetTests(offender)).toEqual(["it('races five rounds', async () => {"]);

    // NEGATIVE — the same body with a budget declared. This is the fix, so it
    // must not still read as the defect.
    const budgeted = [
      "it('races five rounds', { timeout: RACE_TEST_TIMEOUT_MS }, async () => {",
      '  for (let round = 0; round < 5; round += 1) {',
      '    await truncateAuthTables();',
      '  }',
      '});',
    ].join('\n');
    expect(loopedDatabaseResetTests(budgeted)).toEqual([]);

    // NEGATIVE — a loop AND a reset in one body, but the reset is not IN the
    // loop. Proximity is not the predicate; the brace is. A scan that answered
    // "both tokens appear" would report this, and this is the ordinary shape.
    const afterLoop = [
      "it('checks four levels then tidies up', async () => {",
      "  for (const level of ['open', 'limited']) {",
      '    await check(level);',
      '  }',
      '  await truncateAuthTables();',
      '});',
    ].join('\n');
    expect(loopedDatabaseResetTests(afterLoop)).toEqual([]);

    // NEGATIVE — PROSE. `planTargetLockService.test.ts`'s header names
    // `truncateAuthTables` while explaining the drain, and `db-reset.ts`'s names
    // it too. A guard that reads a comment as code reports its own documentation.
    const prose = [
      '// for each round we call truncateAuthTables() — see the drain note above.',
      '/* for (…) { await truncateAuthTables(); } is the shape this file avoids. */',
      "it('is fine', async () => { await work(); });",
    ].join('\n');
    expect(loopedDatabaseResetTests(prose)).toEqual([]);

    // NEGATIVE — a scanner FIXTURE in a template literal.
    // `projectSquareRanking.test.ts` feeds its own scanner source containing a
    // literal `it(`, and a raw-text scan blames that file for its test data.
    const fixture = [
      'const SAMPLE = `',
      "it('sample', async () => { for (;;) { await resetDatabase(); } });",
      '`;',
      "it('scans the sample', () => { expect(scan(SAMPLE)).toEqual([]); });",
    ].join('\n');
    expect(loopedDatabaseResetTests(fixture)).toEqual([]);

    // NEGATIVE — a TITLE containing the word "timeout" must not be read as a
    // declared budget. Strings are blanked before the options position is read,
    // so the exemption cannot be bought with a title.
    const titledTimeout = [
      "it('survives a timeout: the abandoned round', async () => {",
      '  for (let round = 0; round < 5; round += 1) {',
      '    await truncateAuthTables();',
      '  }',
      '});',
    ].join('\n');
    expect(loopedDatabaseResetTests(titledTimeout)).toEqual([
      "it('survives a timeout: the abandoned round', async () => {",
    ]);

    // And the stripper preserves indices, which is what lets the report quote
    // the ORIGINAL line rather than a blanked one.
    expect(stripCommentsAndStrings(offender)).toHaveLength(offender.length);
  });

  it('the reset-call set is the one tests actually use', () => {
    // The predicate is only as wide as this list. If a third reset helper is
    // introduced and not named here, the scan goes quietly narrow — so assert
    // both names still exist at their door rather than trusting the constant.
    const door = readFileSync(join(ROOT, 'tests/helpers/db.ts'), 'utf8');
    expect(door).toContain('truncateAuthTables');
    expect(DATABASE_RESET_CALLS).toContain('truncateAuthTables');
    expect(DATABASE_RESET_CALLS).toContain('resetDatabase');
  });

  it('no test in the tree resets the database per round on the 15 s default', () => {
    const offenders = FILES.flatMap((file) =>
      loopedDatabaseResetTests(readFileSync(join(ROOT, file), 'utf8')).map(
        (opening) => `${file} — ${opening}`,
      ),
    );

    expect(
      offenders,
      `These tests reset the database INSIDE a loop while riding vitest.config.ts's 15 s ` +
        `testTimeout. A truncate takes AccessExclusiveLock on the whole table set, so a loop of ` +
        `them is lock-wait bound and degrades non-linearly under shard contention — which is how ` +
        `a test like this reds a pull request that has nothing to do with it (MOTIR-3736, ` +
        `MOTIR-4089).\n\n` +
        `Declare a MEASURED budget in the it(...) options position — ` +
        `it('…', { timeout: RACE_TEST_TIMEOUT_MS }, async () => …) — and say in a comment what ` +
        `you measured. Do not remove the rounds: the loop is what makes the concurrency real.\n\n` +
        `${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
