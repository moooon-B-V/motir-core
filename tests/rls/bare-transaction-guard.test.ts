import { beforeAll, describe, expect, it } from 'vitest';
import { gatedBareTransactions, scanBareTransactions } from './bareTransactionScan';
import { bareTransactionSites } from './callSiteScan';

// The BARE-TRANSACTION guard (MOTIR-2876) — the THIRD axis, and the one the
// other two guards are structurally blind to.
//
// `singleton-read-guard.test.ts` asks whether a read CAN be bound.
// `call-site-guard.test.ts` asks whether its callers DO bind it.
// This one asks the question that decides whether rows come back:
//
//     the caller passes a `tx` — but what did that transaction BIND?
//
// ⚠️ THIS GUARD EXISTS BECAUSE A COUNT IS NOT A CLASSIFICATION. The sibling
// guard already ratchets `bareTransactionSites().length` at
// `BARE_TRANSACTION_CEILING`, and the prose beside that number carries the real
// claim — *"What remains encloses no policy-gated statement at all."* On the day
// it was written that sentence was false three times over: `getActiveWorkspace`
// (a 404 for every signed-in user), `ensureDefaultWorkspace` (a duplicate
// default workspace) and `defaultLoadMembers` (every imported issue unassigned)
// were all inside the ceiling and the ratchet was green. A count cannot say
// WHICH sites are benign, so a human said it in a comment, and the comment
// rotted. This file turns that sentence into an assertion.
//
// The division of labour is the one MOTIR-2784 established: the machine
// enumerates, a human adjudicates, and a site nobody has ruled on fails the
// build.

/** Why a bare transaction enclosing a policy-gated statement is acceptable. */
type Verdict =
  /**
   * NOT GATED AFTER ALL — the model is in `policyGatedModels` only because that
   * set OVER-APPROXIMATES on purpose (a `workspaceId` column, or a historical
   * `CREATE POLICY` the migration sweep never subtracts). The table carries no
   * policy, so no binding is owed.
   *
   * ⚠️ The reason field must carry the MEASUREMENT, not an inference —
   * `pg_class.relrowsecurity` and a `pg_policies` count — because that is the
   * authority and the schema heuristic is not.
   */
  | 'no-policy'
  /**
   * RAW SQL whose target the parser cannot name, adjudicated by hand and found
   * to address no policy-gated table. The scan reports these rather than
   * guessing, which is the same choice `singletonReadScan` makes.
   */
  | 'raw-not-gated'
  /**
   * CONFIRMED unbound and confirmed BROKEN under `motir_app`. The value names the
   * card that owns the fix, because that is the unit the work is planned in.
   */
  | 'unbound-transaction';

/**
 * One entry per (FILE, enclosing function), matching `callSiteScan`'s choice of
 * a LINE-INDEPENDENT key: a transaction that moves down its file is the same
 * adjudication, and keying on the line would make every unrelated edit a
 * re-review.
 *
 * Every reason below was MEASURED on the migrated schema at the commit that
 * shipped this guard, with:
 *
 *   select c.relname, c.relrowsecurity,
 *          (select count(*) from pg_policies p where p.tablename = c.relname)
 *     from pg_class c join pg_namespace n on n.oid = c.relnamespace
 *    where n.nspname = 'public' and c.relkind = 'r';
 *
 * — not inferred from the card, and not copied from the sibling guard.
 */
const BARE_TRANSACTION_VERDICTS: Record<string, readonly [Verdict, string]> = {
  // `device_code` carries a `workspaceId` column, which is the whole reason the
  // schema heuristic puts it in scope, and no policy whatsoever. The sibling
  // guard reached the same verdict for `deviceCodeRepository.findByUserCodeForRead`.
  'lib/services/cliDeviceService.ts#start': [
    'no-policy',
    'device_code: relrowsecurity=f, 0 rows in pg_policies — measured',
  ],
  'lib/services/cliDeviceService.ts#approve': [
    'no-policy',
    'device_code: relrowsecurity=f, 0 rows in pg_policies — measured',
  ],
  'lib/services/cliDeviceService.ts#poll': [
    'no-policy',
    'device_code: relrowsecurity=f, 0 rows in pg_policies — measured',
  ],

  // Raw SQL reached one hop into a repository. Adjudicated by reading the
  // statement's actual target, then measuring that table.
  'lib/services/rateLimitService.ts#increment': [
    'raw-not-gated',
    'rateLimitCounterRepository.increment -> rate_limit_counter: relrowsecurity=f, 0 policies',
  ],
  'lib/services/rateLimitService.ts#sweepExpired': [
    'raw-not-gated',
    'rateLimitCounterRepository.deleteExpired -> rate_limit_counter: relrowsecurity=f, 0 policies',
  ],
  'lib/services/usersService.ts#changePassword': [
    'raw-not-gated',
    'accountRepository.lockCredentialByUserId -> account: relrowsecurity=f, 0 policies',
  ],
  'lib/services/usersService.ts#requestEmailChange': [
    'raw-not-gated',
    'userRepository.lockById -> user: relrowsecurity=f, 0 policies',
  ],
  'lib/services/usersService.ts#confirmEmailChange': [
    'raw-not-gated',
    'userRepository.lockById -> user: relrowsecurity=f, 0 policies',
  ],
};

/**
 * The ratchet, MEASURED by the scan on the commit that shipped this guard.
 *
 * ⚠️ May only ever go DOWN. If a change makes this fail, bind the transaction —
 * never raise the ceiling. Unlike the sibling `BARE_TRANSACTION_CEILING`, this
 * number counts only the sites whose bodies actually REACH a policy-gated
 * statement, so there is no legitimate reason for it to rise: a new bare
 * transaction over non-gated tables does not move it at all.
 *
 * 8 = 3 `no-policy` (cliDeviceService) + 5 `raw-not-gated` (rateLimit ×2,
 * usersService ×3). Every one is adjudicated above, and there are no
 * `unbound-transaction` verdicts left — MOTIR-2874 bound the last three.
 */
const GATED_BARE_TRANSACTION_CEILING = 8;

describe('bare `db.$transaction`s enclosing policy-gated statements are all accounted for', () => {
  // WARM THE SCAN ONCE, in a hook with its own budget — the reason
  // `call-site-guard.test.ts` gives: the compiler-API walk over `lib/` + `app/`
  // is a few seconds bare, and under `vitest run --coverage` the v8 provider
  // instruments it heavily enough to blow the repo's 15 s `testTimeout`. The scan
  // memoises per root, so every `it` below reads a cache hit.
  //
  // ⚠️ Do NOT "fix" a recurrence by raising `testTimeout`: that is a global knob
  // and this is one expensive fixture.
  beforeAll(() => {
    scanBareTransactions();
  }, 120_000);

  it('every gated site has a verdict, and every verdict names a real site', () => {
    const scanned = [...new Set(gatedBareTransactions().map((s) => s.key))].sort();
    const declared = Object.keys(BARE_TRANSACTION_VERDICTS).sort();

    const undeclared = scanned.filter((k) => !declared.includes(k));
    const stale = declared.filter((k) => !scanned.includes(k));

    // Two messages, because the two failures need opposite fixes.
    expect(
      undeclared,
      'A bare `db.$transaction` encloses a statement against a policy-gated table. It ' +
        'binds NO GUC, so the policy compares against NULL: a SELECT returns FEWER ROWS ' +
        'AND RAISES NOTHING, and a write matches nothing and raises nothing. Use ' +
        'withWorkspaceContext / withWorkspaceServiceContext / withUserContext — or, when the ' +
        'workspace is not known until partway through the transaction, bindWorkspaceContext / ' +
        'bindOrganizationContext at the point it becomes known, BEFORE the first tenant ' +
        'statement — or add an entry here saying, with a measurement, why the table is not ' +
        'actually gated.',
    ).toEqual([]);
    expect(
      stale,
      'BARE_TRANSACTION_VERDICTS names a site the scanner no longer finds. If you bound ' +
        'or deleted the transaction, delete its entry too — a stale allowlist hides the next one.',
    ).toEqual([]);
  });

  it('the gated bare-transaction count only ever falls', () => {
    const sites = gatedBareTransactions();
    expect(
      sites.length,
      `${sites.length} bare transactions enclose a policy-gated statement (ceiling ` +
        `${GATED_BARE_TRANSACTION_CEILING}). If this ROSE, a new one was written — bind it ` +
        'rather than adding an entry.',
    ).toBeLessThanOrEqual(GATED_BARE_TRANSACTION_CEILING);
  });

  it('every unbound-transaction verdict names the card that owns the fix', () => {
    const nameless = Object.entries(BARE_TRANSACTION_VERDICTS)
      .filter(([, [verdict]]) => verdict === 'unbound-transaction')
      .filter(([, [, reason]]) => !/^MOTIR-\d+ · \w+$/.test(reason))
      .map(([key, [, reason]]) => `${key} -> "${reason}"`);

    expect(
      nameless,
      'An `unbound-transaction` verdict must name the owning card and service ' +
        '(e.g. `MOTIR-2874 · workspacesService`), because that is the unit the binding ' +
        'work is planned in.',
    ).toEqual([]);
  });

  it('no site is left carrying an `unbound-transaction` verdict', () => {
    // The verdict kind stays in the union rather than being deleted, because it is
    // how the NEXT one gets adjudicated. What must never come back is a *standing*
    // entry — a site recorded as broken and left that way.
    const open = Object.entries(BARE_TRANSACTION_VERDICTS)
      .filter(([, [verdict]]) => verdict === 'unbound-transaction')
      .map(([key]) => key);
    expect(
      open,
      'an `unbound-transaction` entry is a KNOWN defect parked in an allowlist. Bind the ' +
        'transaction rather than recording it here.',
    ).toEqual([]);
  });

  it('every `no-policy` / `raw-not-gated` reason carries a MEASUREMENT, not an inference', () => {
    // The one field that decides whether an exemption is trustworthy. `device_code
    // is internal` is a belief; `relrowsecurity=f, 0 policies` is a reading, and the
    // next person can re-run it. MOTIR-2815 is the precedent: eighteen tables were
    // out of scope on a plausible-sounding inference until someone measured.
    const unmeasured = Object.entries(BARE_TRANSACTION_VERDICTS)
      .filter(([, [verdict]]) => verdict === 'no-policy' || verdict === 'raw-not-gated')
      .filter(([, [, reason]]) => !/relrowsecurity=f/.test(reason))
      .map(([key]) => key);

    expect(
      unmeasured,
      'a `no-policy` / `raw-not-gated` reason must quote the measurement ' +
        '(`relrowsecurity=f, 0 policies`) — the schema heuristic is not the authority, ' +
        '`pg_class` is.',
    ).toEqual([]);
  });

  it('the two enumerations of `db.$transaction` cannot drift apart', () => {
    // This scan and `callSiteScan.bareTransactionSites` both walk `lib/` + `app/`
    // for the same construct, and two enumerations of one thing drift. They are
    // pinned to each other here rather than one being rewritten in terms of the
    // other, because they answer different questions and the sibling's ratchet
    // must keep working unchanged.
    //
    // The sibling SKIPS `lib/workspaces/context.ts` and `lib/organizations/context.ts`
    // by filename; this scan needs no skip list, because those files are recognised
    // STRUCTURALLY as `binds-inline` — which is the stronger form, and the reason
    // the difference is a superset rather than a disagreement.
    const mine = new Set(scanBareTransactions().map((s) => `${s.file}:${s.line}`));
    const theirs = bareTransactionSites().map((s) => `${s.file}:${s.line}`);

    const missed = theirs.filter((k) => !mine.has(k));
    expect(
      missed,
      'callSiteScan.bareTransactionSites found a bare transaction this scan did not. ' +
        'The two walks have diverged — fix this scan, not the assertion.',
    ).toEqual([]);
    expect(mine.size).toBeGreaterThanOrEqual(theirs.length);
  });

  it('the scanner rules correctly on a fixture carrying every verdict', () => {
    // THE NEGATIVE CASE, as a permanent test rather than a one-off check, and run
    // against a fixture ROOT so proving the detector works can never leave a stray
    // unbound transaction in a real service.
    const root = 'tests/rls/__fixtures__/bareTransactions';
    const byEnclosing = new Map(scanBareTransactions(root).map((s) => [s.enclosing, s]));

    // Pinned INDIVIDUALLY. One `toEqual` over the set would pass for the wrong
    // reason the day the scan returns nothing at all.
    const verdictOf = (fn: string) => byEnclosing.get(fn)?.verdict;

    // (A)–(C), (H) — the findings.
    expect(verdictOf('bareWithMandatoryTxRead'), 'a MANDATORY-`tx` gated read').toBe(
      'gated-statement',
    );
    expect(verdictOf('bareWithDirectRead'), 'a statement issued on the tx itself').toBe(
      'gated-statement',
    );
    expect(verdictOf('bareWithNonBindingHelper'), 'one hop into a non-binding helper').toBe(
      'gated-statement',
    );
    expect(verdictOf('bareWithRaw'), 'raw SQL is adjudicated, not assumed benign').toBe(
      'gated-statement',
    );

    // (D) — THE ORDER CASE, and the reason `binds-inline` is not a boolean.
    expect(
      verdictOf('bareBindingAfterRead'),
      'a binding that happens AFTER the read cannot retroactively bind it — this is ' +
        '`ensureDefaultWorkspace`, and a whole-site boolean gets it wrong',
    ).toBe('gated-statement');

    // (E)–(F) — the legitimate inline binds, recognised STRUCTURALLY.
    expect(verdictOf('bareBindingBeforeRead'), 'set_config in the body, before the read').toBe(
      'binds-inline',
    );
    expect(verdictOf('bareBindingHelperOnly'), 'a helper that binds before its own reads').toBe(
      'binds-inline',
    );

    // (G) — nothing gated to be blind to.
    expect(verdictOf('bareNonGated')).toBe('no-gated-statement');

    // (I) — a binding context is not a bare transaction, so it is not reported.
    expect(byEnclosing.has('bound'), 'withWorkspaceContext is not a bare transaction').toBe(false);

    // (J) — THE PINNED LIMIT. One hop is the documented depth; a helper calling a
    // helper is out of reach. Asserted rather than left implicit, so widening the
    // scan later is a visible decision.
    expect(
      verdictOf('bareTwoHops'),
      'two hops is out of reach by design — if this changed, the scan was widened',
    ).toBe('no-gated-statement');

    // (K)–(N) — THE IMPORTED BINDER (MOTIR-2945). `bindWorkspaceContext` is the
    // answer `lib/workspaces/context.ts` documents for a workspace known only
    // partway through a transaction, and it is always reached across a module
    // boundary — so a scan that followed same-file helpers alone called the one
    // correctly-bound shape a finding, and the guard's own message then offered
    // the reader nothing to record but a false verdict.
    expect(
      verdictOf('bareBindingViaImportedBinder'),
      'the blessed mid-block binder, imported — a bound transaction is not a finding',
    ).toBe('binds-inline');

    // The positional half, one module over: (D) for the import path. If this ever
    // reads `binds-inline`, following the import became a whole-site boolean.
    expect(
      verdictOf('bareImportedBinderAfterRead'),
      'an imported binder called AFTER the read binds nothing retroactively',
    ).toBe('gated-statement');

    // The two controls that keep "resolved" from decaying into "named".
    expect(
      verdictOf('bareWithImportedNonBinder'),
      'handing a `tx` across a module boundary is not a binding — the callee must bind',
    ).toBe('gated-statement');
    expect(
      verdictOf('bareWithLocalNamesakeBinder'),
      'a LOCAL function named `bindWorkspaceContext` that binds nothing must not clear the ' +
        'site — the callee is resolved to a declaration, never matched by name',
    ).toBe('gated-statement');
  });

  it('the scanner actually finds the sites it is pointed at (a live negative)', () => {
    // A scanner that silently returns nothing passes forever. Pin that it walks the
    // real tree, resolves the schema, and classifies in every direction.
    const all = scanBareTransactions();
    expect(all.length).toBeGreaterThan(20);
    expect(all.some((s) => s.verdict === 'binds-inline')).toBe(true);
    expect(all.some((s) => s.verdict === 'no-gated-statement')).toBe(true);
    // The binding contexts themselves are the canonical inline binders, and they
    // are found by what they DO — no filename list.
    expect(
      all.filter((s) => s.file === 'lib/workspaces/context.ts').map((s) => s.verdict),
      'the context wrappers bind inline and are recognised structurally',
    ).not.toContain('gated-statement');
  });

  it('the three defects MOTIR-2874 found by hand are FIXED, and the scanner says so', () => {
    // The calibration set. Until MOTIR-2874 these three were live, and BOTH existing
    // scanners reported the class empty — `getActiveWorkspace` (a 404 for every
    // signed-in user), `ensureDefaultWorkspace` (a duplicate default workspace) and
    // `defaultLoadMembers` (every imported issue unassigned).
    //
    // This scanner's detection power on exactly those three is proven against the
    // PRE-FIX tree in the PR body, and by fixture case (A) for `defaultLoadMembers`'
    // shape and case (D) for `ensureDefaultWorkspace`'s. Here the assertion is the
    // regression guard: a reappearance is the same defect coming back.
    const gated = gatedBareTransactions().map((s) => s.key);
    for (const key of [
      'lib/services/workspacesService.ts#getActiveWorkspace',
      'lib/services/workspacesService.ts#ensureDefaultWorkspace',
      'lib/import/engine/importEngineService.ts#defaultLoadMembers',
    ]) {
      expect(gated, `${key} was bound by MOTIR-2874 and must stay bound`).not.toContain(key);
    }
  });
});
