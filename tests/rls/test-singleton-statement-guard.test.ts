import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { policyGatedModels } from './singletonReadScan';
import { remeasureFirst } from './remeasureFirst';
import {
  DISPOSITIONED_FILES,
  NO_POLICY_MODELS,
  byArea,
  countByVerdict,
  policyNamedModels,
  scanTestSingletonStatements,
  unconverted,
  type TestSingletonStatement,
} from './testSingletonStatementScan';

// The TEST direct-statement guard (MOTIR-2918).
//
// Same division of labour as its four siblings: the machine enumerates, a human
// adjudicates, the ratchets record where the work stands, and a change that
// quietly re-opens settled ground is a red build rather than a reviewer's job to
// notice. What is new here is only WHICH shape is enumerated — see
// `testSingletonStatementScan.ts`'s header for why five existing scanners all
// read past `db.<model>.<op>(…)` written directly in a test.
//
// ⚠️ THE NUMBERS BELOW ARE NOT THE CARD'S 544, AND THE DIFFERENCE IS A
// DEFINITION, NOT A WORLD THAT MOVED (`notes.html` #278 — a metric is a claim
// about what it counts). MOTIR-2918's body reported "544 statements across 137
// files" from a grep at `b99f7e53`. This scanner reports 575 statements across
// 130 files at `bd0584c5`, and the two are answers to different questions:
//
//   • the grep counted LINES matching a whitelist of fourteen operation names;
//     this counts CALL-SITE NODES over ANY operation, so a wrapped call is one
//     statement and `db.widget.someNewOp()` is in scope the day it is written;
//   • the grep's file count includes files whose only hit is a `$queryRaw` or a
//     `.db.` substring; this splits raw statements out because their target
//     table is not nameable from the syntax;
//   • and the grep could not subtract, so its 544 mixes the 74 statements whose
//     tables carry no policy at all in with the ones that matter.
//
// Neither number is wrong. Quoting one against the other is the mistake.

const FIXTURE = path.join(process.cwd(), 'tests/rls/__fixtures__/testSingletonStatements');

/**
 * ── THE RATCHETS ─────────────────────────────────────────────────────────
 *
 * Two, because the two populations have DIFFERENT REMEDIATIONS and one number
 * would be actionable for neither (MOTIR-2918's fourth instruction).
 *
 * `tests/e2e/**` is a spec seeding through the singleton before it drives the
 * browser. The fix is a seeding HELPER on `adminDb`, applied once per helper —
 * not 452 per-line client swaps. It is latent today because the E2E lane still
 * runs as the owner, and it becomes a hard failure the moment MOTIR-2734 makes
 * `motir_app` the only connection.
 *
 * Everything else is a per-line decision — fixture, assertion, or subject — and
 * is small enough to read: FOUR statements, all in one file, all the same shape.
 *
 * ⚠️ BOTH MAY ONLY EVER FALL. A rise means a new direct statement was written:
 * seed and assert through `adminDb` (`tests/helpers/adminDb.ts`) rather than
 * raising the ceiling. This is a CEILING and not an absolute assertion for the
 * reason MOTIR-2797 ran one before its class closed — 458 sites cannot land in
 * one card, and a number that only falls is the instrument that makes the
 * descent visible. When a population reaches zero, replace ITS ceiling with an
 * absolute assertion, exactly as `test-call-site-guard.test.ts` did.
 *
 * Measured on `origin/main` @ `bd0584c5`; the e2e half RE-MEASURED on
 * `origin/main` @ `d024d863` and lowered by this card's conversion — see below.
 */

/**
 * ⚠️ WHY THIS NUMBER MOVED, AND WHY IT IS A FALL AND NOT A RAISE (MOTIR-2939).
 *
 * It arrived here as 454 and `main` was RED on the merge commit that introduced
 * it. Nothing had ROSE. 454 was measured on this guard's own branch at
 * `bd0584c5`, and `22316a62` — `cloud-board-load.spec.ts`, MOTIR-2912 — merged
 * SEVEN MINUTES before it, adding three undispositioned statements nobody's
 * branch could see. The true count at the merge was 457, so the guard failed on
 * its own arrival, accusing the next person of the seeding it describes below.
 *
 * Measured per commit rather than inferred (`d024d863` = `origin/main` at the
 * time of writing):
 *
 *   a39bd115  454   MOTIR-2763 · cloud-orb-clearance.spec.ts lands
 *   bd0584c5  454   ← the measurement this ceiling shipped as 454
 *   22316a62  457   MOTIR-2912 · cloud-board-load.spec.ts lands  (+3)
 *   05ac5337  457   ← MOTIR-2918 merges carrying the stale 454. RED.
 *   d024d863  457
 *
 * `cloud-orb-clearance` is NOT part of the rise — it landed BEFORE the 454
 * reading and its two statements are inside that baseline. Recorded because the
 * card that filed this named both specs, and a wrong attribution left standing
 * costs the next reader the same measurement.
 *
 * 452 = 457 − 5: BOTH cloud specs converted to `adminDb` (the three that caused
 * the rise, plus orb-clearance's two, which are the same shape and the same
 * hazard). So this is a real descent past the number that was stale, not a
 * ceiling raised to cover debt — which is the one move this ratchet exists to
 * refuse, and the reason the arithmetic above is written out rather than
 * asserted.
 *
 * THE HAZARD IS STRUCTURAL AND SURVIVES THIS FIX: any ceiling measured on a
 * BRANCH is stale the moment a sibling merges beneath it, and only a ceiling of
 * 0 is immune. MOTIR-2941 DECIDED that in
 * `docs/decisions/ratchet-constant-staleness.md`: the constants stay
 * branch-measured (deriving them from `origin/main` at run time was rejected,
 * with its price), and every non-zero one instead opens its failure message with
 * `remeasureFirst(…)` so the reader is told to re-measure before hunting a
 * culprit. `ratchet-staleness-guard.test.ts` enforces that on every ratchet,
 * including any added after this one.
 */
const UNCONVERTED_E2E_CEILING = 452;
const UNCONVERTED_VITEST_CEILING = 4;

/**
 * `$queryRaw*` / `$executeRaw*` on the singleton, whose target table a parser
 * cannot name. Reported and ratcheted rather than dropped — dropping the shape
 * you cannot rule on is the exact failure this whole file exists to end.
 *
 * 30 = 28 under `tests/**` (mostly the `tests/helpers/db.ts` truncation
 * machinery and the `app-role-*` suites, which read `current_user` and friends)
 * + 2 in `tests/e2e/**`. Adjudicating them per site is NOT this card's scope:
 * this card ships the instrument, and the card that converts sizes itself off
 * these numbers.
 */
const RAW_CEILING = 30;

const key = (s: TestSingletonStatement): string => `${s.key} db.${s.model}.${s.op ?? '<uncalled>'}`;

describe('the direct-statement scanner rules on every shape', () => {
  it('classifies the fixture in both directions', () => {
    const { statements } = scanTestSingletonStatements(FIXTURE);

    expect(statements.map((s) => `${s.model}.${s.op}:${s.verdict}`).sort()).toEqual(
      [
        // GATED on the singleton, a read — the class.
        'widget.findMany:undispositioned',
        // GATED on the singleton, a WRITE. The operation name is not the
        // discriminator, which is why this walk carries no whitelist of names.
        'widget.deleteMany:undispositioned',
        // GATED through the INLINE `(tx ?? db)` fallback.
        'widget.findMany:undispositioned',
        // NOT GATED — no policy applies, the singleton is correct.
        'globalSetting.findMany:not-gated',
      ].sort(),
    );
    expect(countByVerdict(statements)).toEqual({
      'not-gated': 1,
      'no-policy': 0,
      subject: 0,
      fixture: 0,
      assertion: 0,
      undispositioned: 3,
    });
  });

  it('reports NEITHER `adminDb` NOR a bare `tx` — the two forms that are already correct', () => {
    // The load-bearing negative case. `adminDb` is the OWNER, which is what a
    // fixture, a teardown and a direct-DB assertion are supposed to use; a bare
    // `tx` inside a bound context is the FIXED form. A scanner that reported
    // either would be telling authors to undo the remediation this family has
    // spent twenty cards applying.
    //
    // The fixture calls `adminDb.widget.deleteMany`, `adminDb.widget.count` and
    // `tx.widget.findMany`, and `widget` is the same gated model the reported
    // statements address — so only the CLIENT separates them.
    const { statements } = scanTestSingletonStatements(FIXTURE);
    expect(statements.filter((s) => s.model === 'widget')).toHaveLength(3);
    expect(statements.map((s) => s.op).filter((op) => op === 'count')).toEqual([]);
  });

  it('sees a model addressed through the INLINE `(tx ?? db)` fallback', () => {
    // Pinned as its own case, not left to the count above, because this is the
    // shape that hid eleven repository methods from `testCallSiteScan` for
    // months (MOTIR-2911) and the wrong answer is the REASSURING one: an
    // unrecognised client yields no statement at all, which reads as a clean
    // file rather than as an error.
    //
    // The predicate is IMPORTED from `testCallSiteScan` (`isClientExpression`,
    // with `SINGLETON_ONLY`), so this assertion also pins that the two scanners
    // cannot drift on the unwrapping — only on the name set, which is the part
    // that legitimately differs.
    const { statements } = scanTestSingletonStatements(FIXTURE);
    const reads = statements.filter((s) => s.model === 'widget' && s.op === 'findMany');
    expect(reads).toHaveLength(2); // the bare `db.` one AND the `(tx ?? db)` one
  });

  it('a shape it cannot rule on fails LOUDLY instead of defaulting to `not-gated`', () => {
    // `db.ghost` names no model in the fixture schema. Filing it as `not-gated`
    // would be a POSITIVE claim that no policy applies to a table nobody looked
    // up — the precise failure that made eleven methods read as safe in
    // MOTIR-2911. Dropping it silently would hide a renamed model from every
    // future sweep. It must surface.
    const { unclassifiable } = scanTestSingletonStatements(FIXTURE);
    expect(unclassifiable).toHaveLength(1);
    expect(unclassifiable[0]?.property).toBe('ghost');
  });

  it('a raw statement is reported SEPARATELY, not as a model verdict', () => {
    // `$queryRaw`'s target is not nameable from the syntax, so it cannot carry a
    // gated/ungated verdict — and `$transaction` is not a statement against a
    // table at all and belongs to `bareTransactionScan`. Both are in the fixture;
    // exactly one of them appears here.
    const { raw } = scanTestSingletonStatements(FIXTURE);
    expect(raw.map((r) => r.api)).toEqual(['$queryRaw']);
  });
});

describe('the ratchets over the real test suite', () => {
  // ⚠️ Scan ONCE and share it. The walk parses every `.ts` under `tests/`, which
  // is fine once and is not fine once per `it` on a CI runner with three vitest
  // shards competing for the box — the reason `test-call-site-guard.test.ts`
  // gives, and the failure it actually hit. The scan is memoised per root, so
  // every `it` below reads a cache hit.
  let scan: ReturnType<typeof scanTestSingletonStatements>;
  beforeAll(() => {
    scan = scanTestSingletonStatements();
  }, 60_000);

  it('the `tests/e2e/**` ceiling only ever falls', () => {
    const e2e = byArea(unconverted(scan.statements)).e2e;

    expect(
      e2e.length,
      remeasureFirst('UNCONVERTED_E2E_CEILING') +
        `${e2e.length} direct singleton statements under \`tests/e2e/**\` still have to change ` +
        `(ceiling ${UNCONVERTED_E2E_CEILING}).\n\n` +
        `If it genuinely ROSE against \`origin/main\`, a spec was written that seeds through ` +
        `\`@/lib/db\`. Under ` +
        `\`motir_app\` that write is REFUSED and that read returns [] — neither raises — so ` +
        `the spec drives a browser against a database it believes it populated. Seed through ` +
        `\`adminDb\` (\`tests/helpers/adminDb.ts\`), ideally via a helper under ` +
        `\`tests/e2e/_helpers/\`, rather than raising this number.\n\n` +
        `This population is a SEEDING-HELPER problem, not ${UNCONVERTED_E2E_CEILING} per-line swaps, which is why ` +
        `it ratchets apart from the vitest half.`,
    ).toBeLessThanOrEqual(UNCONVERTED_E2E_CEILING);
  });

  it('the vitest ceiling only ever falls', () => {
    const vitest = byArea(unconverted(scan.statements)).vitest;

    expect(
      vitest.length,
      remeasureFirst('UNCONVERTED_VITEST_CEILING') +
        `${vitest.length} direct singleton statements outside \`tests/e2e/**\` still have to ` +
        `change (ceiling ${UNCONVERTED_VITEST_CEILING}):\n` +
        vitest.map((s) => `  ${key(s)} [${s.verdict}]`).join('\n') +
        `\n\nUnder \`motir_app\` an unbound statement against a policy-gated table is not an ` +
        `error: a read returns [] and a write matches nothing. An assertion expecting rows ` +
        `fails confusingly; an assertion expecting EMPTINESS passes while checking nothing.\n\n` +
        `A fixture write and a direct-DB assertion read both belong on \`adminDb\`. A ` +
        `statement whose SUBJECT is the unbound behaviour stays on \`db\` and is recorded in ` +
        `\`DISPOSITIONED_FILES\` with the card that decided it.`,
    ).toBeLessThanOrEqual(UNCONVERTED_VITEST_CEILING);
  });

  it('the raw-statement ceiling only ever falls', () => {
    expect(
      scan.raw.length,
      remeasureFirst('RAW_CEILING') +
        `${scan.raw.length} \`$queryRaw*\` / \`$executeRaw*\` statements run on the singleton ` +
        `under \`tests/\` (ceiling ${RAW_CEILING}). Their target table is not nameable from ` +
        `the syntax, so they are enumerated rather than verdicted — but they are enumerated, ` +
        `because the shape nobody counts is the shape that survives twenty sweeps.`,
    ).toBeLessThanOrEqual(RAW_CEILING);
  });

  it('every statement in the suite is classifiable', () => {
    expect(
      scan.unclassifiable,
      `these statements address something off the \`db\` client that is neither a Prisma ` +
        `model nor a \`$\` client API — usually a renamed model or a helper hung off the ` +
        `client:\n` +
        scan.unclassifiable.map((u) => `  ${u.file}:${u.line} db.${u.property}`).join('\n'),
    ).toEqual([]);
  });

  it('the file-level adjudication is exactly what a human put there', () => {
    // The one class of verdict a parser cannot derive: `db.workItem.findMany()`
    // seeding a board, one asserting a service wrote the row, and one whose whole
    // subject is what the policy does to an unbound read are the same tokens on
    // the page. So the set is pinned, and a new entry fails here until somebody
    // adds it on purpose — an entry silently converts one kind of work into
    // another, or into no work at all.
    expect(Object.keys(DISPOSITIONED_FILES).sort()).toEqual([
      'tests/cli/cli-device-routes.test.ts',
      'tests/tenant-root-creation-rls.test.ts',
    ]);
    for (const [file, [, reason]] of Object.entries(DISPOSITIONED_FILES)) {
      expect(existsSync(path.join(process.cwd(), file)), `${file} does not exist`).toBe(true);
      expect(reason, `${file}'s adjudication must cite the card that decided it`).toMatch(
        /MOTIR-\d+/,
      );
    }
  });

  it('a file ruling is checked AFTER `no-policy`, never before', () => {
    // The ordering bug `ADJUDICATED_UNBOUND_FILES` had to be corrected into,
    // pinned here against REAL data rather than a fixture — which is stronger,
    // because the fixture would only prove the shapes its author thought of.
    //
    // `tests/cli/cli-device-routes.test.ts` is dispositioned `assertion` and
    // holds twelve statements against `device_code` (relrowsecurity=f, 0
    // policies). If the file ruling won first, all twelve would read as work and
    // be converted for no reason at all.
    //
    // It used to hold four `api_token` statements as well, and the pairing was
    // the point. MOTIR-2952 converted those to `adminDb`, which does not weaken
    // this case: the ordering claim always rested on the `device_code` twelve —
    // they are `no-policy` DESPITE a file ruling that says `assertion`, and that
    // is exactly what "checked AFTER `no-policy`" means. The ruling is retained
    // (see `DISPOSITIONED_FILES`) so this fixture keeps existing on real data.
    const routes = scan.statements.filter((s) => s.file === 'tests/cli/cli-device-routes.test.ts');
    expect(countByVerdict(routes)).toEqual({
      'not-gated': 0,
      'no-policy': 12,
      subject: 0,
      fixture: 0,
      assertion: 0,
      undispositioned: 0,
    });
    expect(new Set(routes.filter((s) => s.verdict === 'no-policy').map((s) => s.model))).toEqual(
      new Set(['deviceCode']),
    );
  });

  it('every `no-policy` model carries a MEASUREMENT, and no migration contradicts it', () => {
    // TWO checks, because neither is sufficient alone and they fail in opposite
    // directions. The reason field must quote a `pg_class` reading — the schema
    // heuristic is not the authority, and `device_code is internal` is a belief
    // where `relrowsecurity=f, 0 policies` is a reading the next person can
    // re-run (the rule `bare-transaction-guard.test.ts` enforces on its own
    // `no-policy` entries; MOTIR-2815 is the precedent, where eighteen tables sat
    // out of scope on a plausible-sounding inference).
    //
    // And the machine checks the human back: a reading is a snapshot of one
    // cluster, so an entry whose table any migration puts under RLS is refused
    // outright. It is the cross-check the sibling guard does not have.
    const unmeasured = Object.entries(NO_POLICY_MODELS)
      .filter(([, reason]) => !/relrowsecurity=f/.test(reason))
      .map(([model]) => model);
    expect(
      unmeasured,
      'a `no-policy` reason must quote the measurement (`relrowsecurity=f, 0 rows in ' +
        'pg_policies`) — `pg_class` is the authority, the `workspaceId` column is not.',
    ).toEqual([]);

    const named = policyNamedModels();
    const contradicted = Object.keys(NO_POLICY_MODELS).filter((m) => named.has(m));
    expect(
      contradicted,
      'a `no-policy` entry names a table that a migration puts under row-level security. ' +
        'The exemption is wrong, or the reading was taken against a cluster the migrations ' +
        'had not reached. Re-measure before touching this list.',
    ).toEqual([]);

    // And a dead entry is deleted, not left: a model outside `policyGatedModels`
    // needs no exemption, and an exemption nobody reads is a comment.
    const gated = policyGatedModels();
    const pointless = Object.keys(NO_POLICY_MODELS).filter((m) => !gated.has(m));
    expect(
      pointless,
      'a `no-policy` entry names a model `policyGatedModels` does not report as gated, ' +
        'so it exempts nothing. Delete it — a stale allowlist hides the next one.',
    ).toEqual([]);
  });

  it('the founding instance is fully dispositioned — and so, now, is the twin it found', () => {
    // MOTIR-2918's own acceptance criterion: a scanner that cannot see its own
    // founding instance is not the instrument.
    //
    // `tests/cli/cliDeviceService.test.ts` is the file MOTIR-2911 fixed by hand.
    // Its 29 surviving direct statements are all `device_code`, measured to carry
    // no policy at all — so the file is fully dispositioned, with nothing left to
    // change. On its own that is a WEAK claim, because a fixed file is quiet.
    const founding = scan.statements.filter((s) => s.file === 'tests/cli/cliDeviceService.test.ts');
    expect(founding).toHaveLength(29);
    expect(new Set(founding.map((s) => s.verdict))).toEqual(new Set(['no-policy']));
    expect(unconverted(founding)).toEqual([]);

    // The strong claim is next door, and it is why this file exists. The failures
    // MOTIR-2911 fixed were `expect(await db.apiToken.count()).toBe(0)` — an
    // assertion that passes for the wrong reason under `motir_app`, because the
    // policy hides the rows rather than the count being real. The SAME shape,
    // against the SAME table, sat UNFIXED four times in the sibling file that
    // card's hand-built list never named — at lines 211, 253, 597 and 626. Two
    // grep sweeps walked this population and neither reached it; the first run of
    // this scanner did, and MOTIR-2952 converted all four to `adminDb`.
    //
    // So the assertion INVERTS, and becomes a ratchet rather than a report: the
    // file must hold NO direct statement against `api_token` at all. Only line
    // 253 was ever red (`toBe(1)`); the other three asserted `toBe(0)` and passed
    // for the wrong reason, which is why "the suite is green" was never evidence
    // here and why the number that has to stay pinned is zero, not one.
    const twin = scan.statements.filter(
      (s) => s.file === 'tests/cli/cli-device-routes.test.ts' && s.model === 'apiToken',
    );
    expect(
      twin.map(key),
      'a direct `db.apiToken.*` statement is back in the route test. Under `motir_app` it ' +
        'reads 0 rows whatever the route minted — MOTIR-2952 moved all four to `adminDb`.',
    ).toEqual([]);
  });

  it('REPORTS the per-area split the next card is sized off', () => {
    // A REPORT, not a threshold — printed on every run so the two populations
    // stay readable apart, and asserted only where an assertion is meaningful.
    //
    // Deliberately NOT pinned to exact totals. `not-gated` rises whenever anyone
    // writes a perfectly correct `db.user.findMany()` in a new test, and a guard
    // that reddens for that trains people to edit the guard. What must not rise
    // is the WORK, and that is what the three ceilings above hold.
    //
    // The measured shape on `origin/main` @ `d024d863` PLUS this card's
    // conversion (MOTIR-2939), for the PR body and for whoever sizes the
    // conversion cards. Re-measured rather than adjusted: the previous reading
    // here was taken at `bd0584c5`, and reasoning forward from a stale reading
    // is the exact mistake that made this file's ceiling wrong.
    //
    //   572 statements across 129 files  ·  30 raw (28 vitest + 2 e2e)
    //   ────────────────────────────────────────────────────────────────
    //             not-gated  no-policy  subject  fixture  assertion  undisp.
    //   e2e              67          1        0        0          0      452
    //   vitest            6         41        1        0          4        0
    //
    // (was 579 / 131 at `d024d863`; the seven statements the two cloud specs
    //  seeded through `@/lib/db` now run on `adminDb`, so both files leave the
    //  population entirely — five of the seven were the undispositioned work.)
    //
    const areas = byArea(scan.statements);
    const e2e = countByVerdict(areas.e2e);
    const vitest = countByVerdict(areas.vitest);
    // eslint-disable-next-line no-console
    console.log(
      `[MOTIR-2918] ${scan.statements.length} direct singleton statements across ` +
        `${new Set(scan.statements.map((s) => s.file)).size} files, plus ${scan.raw.length} raw\n` +
        `  tests/e2e/**  ${JSON.stringify(e2e)}\n` +
        `  elsewhere     ${JSON.stringify(vitest)}`,
    );

    // The one invariant worth asserting: the split is a PARTITION. If a third
    // area ever appears, or `areaOf` stops being total, the two ceilings above
    // silently stop covering everything — which is the failure mode this whole
    // file is about, arriving through the reporting rather than the parse.
    expect(areas.e2e.length + areas.vitest.length).toBe(scan.statements.length);
    expect(byArea(scan.raw).e2e.length + byArea(scan.raw).vitest.length).toBe(scan.raw.length);
    expect(
      Object.values(e2e).reduce((a, b) => a + b, 0) +
        Object.values(vitest).reduce((a, b) => a + b, 0),
    ).toBe(scan.statements.length);
  });
});
