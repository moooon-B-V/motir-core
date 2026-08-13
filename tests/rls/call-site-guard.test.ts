import { describe, expect, it } from 'vitest';
import { bareTransactionSites, scanCallSites, unboundCallSites } from './callSiteScan';

// The CALL-SITE guard (MOTIR-2845) — the second axis of the singleton-read
// guard, and the half `tests/rls/singleton-read-guard.test.ts` is structurally
// blind to.
//
// That guard asks whether a repository read CAN be bound (`tx ?? db`). This one
// asks whether its callers actually DO. Both failures have the identical
// symptom — no GUC on the transaction, the RLS policy compares against NULL, the
// read returns ZERO ROWS AND RAISES NOTHING — and only the first was ever
// detectable, which is why MOTIR-2796 was partitioned into fifty-five repository
// METHODS and named no call site at all.
//
// ⚠️ THIS GUARD EXISTS BECAUSE THE OTHER ONE GOES QUIET. The moment a read gains
// its `tx ?? db`, `singletonReadScan` stops reporting it — the capability is
// there. Nothing then watches whether anyone supplies it. Without this file,
// MOTIR-2796 empties a class rather than closing it, and the next service
// reintroduces the whole thing silently. (`notes.html` #266.)
//
// The division of labour is the one MOTIR-2784 established and
// `tenant-root-creation-rls.test.ts` before it: the machine enumerates, a human
// adjudicates, and a site nobody has ruled on fails the build.

/** Why an unbound call site is acceptable — or is not. */
type Verdict =
  /**
   * CONFIRMED unbound and confirmed BROKEN under `motir_app`: a bindable read of
   * a policy-gated table, called with no transaction. The value names the card
   * that owns the fix, because that is the unit the work is planned in.
   */
  | 'unbound-call-site'
  /**
   * MUST STAY UNBOUND. `work_item_public_project_read` and `project_public_read`
   * (MOTIR-2684) fire only when `app.workspace_id` is UNSET, so binding a public
   * page's read would DISABLE the arm that makes it work. This is the one verdict
   * where the fix would be the regression — see the structural exemption in
   * `docs/decisions/bound-read-transaction-shape.md`.
   */
  | 'public-arm'
  /** No tenant exists at read time; there is nothing to bind. */
  | 'pre-auth'
  /**
   * NOT GATED AT ALL — no binding is owed, and adding one would be noise.
   *
   * ⚠️ This verdict exists because the scope filter OVER-APPROXIMATES, on purpose:
   * `policyGatedModels` asks the SCHEMA whether a model carries a `workspaceId`
   * column, which is cheap and drift-proof and slightly wrong. `pg_policies` is
   * the authority, and a table can carry the column while carrying no policy.
   * The reason field holds the QUERY, so the next reader re-measures instead of
   * trusting this line.
   */
  | 'no-policy'
  /** Fixed: the call now receives a GUC-bound transaction. Only ever REMOVED. */
  | 'bound';

/**
 * One entry per (FILE, read) pair rather than per line, deliberately: a call
 * that moves down its file is the same adjudication, and keying on the line
 * would make every unrelated edit a re-review. A file that calls one read from
 * three places carries one entry and the scan counts three sites.
 */
const CALL_SITE_VERDICTS: Record<string, readonly [Verdict, string]> = {
  'lib/services/cliDeviceService.ts#deviceCodeRepository.findByUserCodeForRead': [
    'no-policy',
    'device_code: relrowsecurity=f, 0 rows in pg_policies — measured, not inferred',
  ],
  'lib/services/publicRequestsService.ts#workItemRepository.findById': [
    'public-arm',
    // Re-adjudicated under MOTIR-2846 (it was carried as `unbound-call-site`).
    // The service header states the reason in so many words: this read is the one
    // that FINDS the item's project, so its workspace is not yet known and there
    // is nothing to bind. `work_item_public_project_read` admits an unbound read
    // of a public project's items and nothing else; the comment INSERT beneath it
    // binds the item's own workspace. Binding here would disable the arm.
    'the id is all the route has — the read is FINDING the workspace, and the public arm admits it',
  ],
  'lib/services/publicProjectsService.ts#workItemRepository.findByIds': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicProjectsService.ts#projectRepository.findById': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicProjectsService.ts#workItemRepository.countProjectIssues': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicProjectsService.ts#workItemRepository.countPublicProjectTreeLevel': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicProjectsService.ts#workItemRepository.findByIdentifier': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicProjectsService.ts#workItemRepository.findByProject': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicProjectsService.ts#workItemRepository.findColumnCards': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicProjectsService.ts#workItemRepository.findPublicHiddenDescendantIds': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicProjectsService.ts#workItemRepository.findPublicProjectTreeLevel': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
};

/**
 * The ratchet, MEASURED by the scan on the commit that shipped this guard — not
 * transcribed from a card. Counts SITES, not entries, because a file that calls
 * one read from three places has three things to fix.
 *
 * ⚠️ May only ever go DOWN. If a change makes this fail, bind the call — never
 * raise the ceiling. MOTIR-2846 drives it to zero.
 *
 * 205 = 183 `no-context` + 22 `in-bare-transaction`. The second number is the
 * sharper one: those reads DO share a transaction, so they look bound in review,
 * and it binds no GUCs.
 *
 * 205 -> 180: MOTIR-2801 bound `boardsService`'s 25 sites — the guard's first
 * consumer, and the reason it was moved early: the plan named four of them.
 * Lowered BY SUBTRACTION of this card's own, never restated as an absolute.
 *
 * ⚠️ 180 -> 189: THE ONE LEGITIMATE RISE, and it needs stating because a ratchet
 * that goes up looks exactly like a regression. MOTIR-2807 made
 * `workItemRepository.findByIds`, `workItemLinkRepository.findByFromItem` and
 * `sprintRepository.findByIds` BINDABLE, which is what puts a read in this
 * scanner's scope at all — so their callers entered the population on the commit
 * that fixed them. Those callers were always dark; they were invisible to BOTH
 * scanners, because the singleton scan saw an unbindable read and this one saw
 * no bindable read to check. Net on that commit: 13 sites bound, 22 revealed,
 * and `UNBOUND_READ_PATH_CEILING` fell 35 -> 31 (`findByToItem` came with the
 * IN-edge half of the same two methods).
 *
 * So the rule, because the next card will hit it: **a rise is permitted ONLY in a
 * commit that also lowers `UNBOUND_READ_PATH_CEILING`, and only with the read
 * that caused it named here.** Anything else is a regression and the fix is to
 * pass the `tx`. Never raise this number to make a build pass — that is the one
 * edit both of these files exist to prevent.
 *
 * 189 -> 177: MOTIR-2802 bound `workItemsService`'s link-edge reads and the
 * item-detail fan-out they sit inside.
 * 177 -> 174: MOTIR-2803 bound the tree / search / stub half of the same file.
 * 174 -> 172: MOTIR-2808 bound the plan-health verdicts and the identifier resolve
 * their subtree read opens on.
 * 172 -> 169: MOTIR-2809 bound the nine single-read services and their
 * out-of-service callers.
 *
 * 169 -> 15: MOTIR-2846 — the sweep this ratchet was built for. It bound the
 * remaining production call sites across 34 files (workItems / workflows /
 * sprints / backlog / plans / dashboards / migrate-onboarding and the long tail),
 * and replaced 28 bare `db.$transaction` service transactions with a binding
 * context. Four of the 169 were never defects: the scanner learned to read a
 * `tx` through a local `(t: Prisma.TransactionClient) => …` callback and through
 * a `tx ?? t` argument, both of which ARE bound (see `callSiteScan.ts`).
 *
 * ⚠️ 15 IS THE FLOOR, and every one of them is adjudicated above as `public-arm`
 * or `no-policy`. **There are no `unbound-call-site` verdicts left.** A rise now
 * means a NEW unbound caller — bind it. The only legitimate rise is still the one
 * described above (a read becoming bindable brings its callers into scope), and
 * it still requires `UNBOUND_READ_PATH_CEILING` to fall in the same commit — but
 * that ceiling is at 0, so in practice this number only ever goes down or stays.
 */
const UNBOUND_CALL_SITE_CEILING = 15;

/**
 * Service functions opening a bare `db.$transaction`, which binds nothing.
 *
 * Tracked separately from the sites above because it is the CAUSE rather than an
 * instance: one bare transaction darkens every read inside it, and a `tx` handed
 * from one into `readProject` / `readProjectByIdentifier` is precisely what
 * `lib/workspaces/tenantRead.ts` warns against — *"Do not pass a transaction that
 * binds no GUCs … the read would see NULL context and return the same false miss
 * this function exists to remove."*
 *
 * Not every one is a defect: a transaction over non-gated tables is fine — and
 * that is what the 32 survivors are: user preferences, rate-limit counters, CLI
 * device codes, the workspace/org bootstrap that runs BEFORE a tenant exists.
 *
 * 60 -> 32: MOTIR-2846 replaced every bare transaction that enclosed a
 * policy-gated read with `withWorkspaceContext` / `withWorkspaceServiceContext`
 * (workItems ×6, dashboards ×7, triage ×5, labels ×3, components ×3, imports ×2,
 * and the rest). What remains encloses no gated read, which is why the number
 * stops here rather than at zero.
 */
const BARE_TRANSACTION_CEILING = 32;

describe('call sites of bindable tenant reads are all accounted for', () => {
  it('every unbound site has a verdict, and every verdict names a real site', () => {
    const scanned = [...new Set(unboundCallSites().map((c) => c.key))].sort();
    const declared = Object.keys(CALL_SITE_VERDICTS).sort();

    const undeclared = scanned.filter((k) => !declared.includes(k));
    const stale = declared.filter((k) => !scanned.includes(k));

    // Two messages, because the two failures need opposite fixes.
    expect(
      undeclared,
      'A service calls a BINDABLE read of a policy-gated table without giving it a ' +
        'transaction. Under the non-bypass role that read returns ZERO ROWS AND RAISES ' +
        'NOTHING, so the caller reports "missing" for a row that exists. Either pass the ' +
        '`tx` (the fix is usually one argument) or add an entry here saying why the read ' +
        'must stay unbound.',
    ).toEqual([]);
    expect(
      stale,
      'CALL_SITE_VERDICTS names a site the scanner no longer finds. If you bound or ' +
        'deleted the call, delete its entry too — a stale allowlist hides the next one.',
    ).toEqual([]);
  });

  it('the unbound call-site count only ever falls', () => {
    const sites = unboundCallSites();
    expect(
      sites.length,
      `${sites.length} call sites invoke a bindable gated read with no bound transaction ` +
        `(ceiling ${UNBOUND_CALL_SITE_CEILING}). If this ROSE, a new caller joined the ` +
        'class — pass the `tx` rather than adding an entry. If it FELL, lower the ceiling ' +
        'in the same commit.',
    ).toBeLessThanOrEqual(UNBOUND_CALL_SITE_CEILING);
  });

  it('the bare-transaction count only ever falls', () => {
    const bare = bareTransactionSites();
    expect(
      bare.length,
      `${bare.length} service functions open a bare \`db.$transaction\` (ceiling ` +
        `${BARE_TRANSACTION_CEILING}). It binds no GUCs, so every gated read inside one ` +
        'is dark while LOOKING bound. Use withWorkspaceContext / ' +
        'withWorkspaceServiceContext instead.',
    ).toBeLessThanOrEqual(BARE_TRANSACTION_CEILING);
  });

  it('every unbound-call-site verdict names the card that owns the fix', () => {
    // The value is the unit of work, not a comment: MOTIR-2846 is planned
    // against it, and a verdict reading `?` would quietly drop the site.
    const nameless = Object.entries(CALL_SITE_VERDICTS)
      .filter(([, [verdict]]) => verdict === 'unbound-call-site')
      .filter(([, [, reason]]) => !/^MOTIR-\d+(\/\d+)? · \w+$/.test(reason))
      .map(([key, [, reason]]) => `${key} -> "${reason}"`);

    expect(
      nameless,
      'An `unbound-call-site` verdict must name the owning card and service ' +
        '(e.g. `MOTIR-2801 · boardsService`), because that is the unit the binding ' +
        'work is planned in.',
    ).toEqual([]);
  });

  it('the public-arm sites are exactly the two PUBLIC services', () => {
    // The one verdict where BINDING would be the regression. Pinned to the files,
    // so a `public-arm` verdict cannot quietly spread to a tenant path as a way
    // of making this guard pass.
    //
    // Two files, not one (MOTIR-2846 added the second): `publicRequestsService`'s
    // opening `work_item` read is the one that FINDS the item's project, so its
    // workspace is not known yet — and `work_item_public_project_read`
    // (`prisma/migrations/20260813210000_public_request_vote_public_read`, which
    // cites it) admits exactly that read of a public project's items. The
    // service's own header states the same thing. Everything BELOW that read in
    // the file already binds.
    const PUBLIC_FILES = [
      'lib/services/publicProjectsService.ts#',
      'lib/services/publicRequestsService.ts#',
    ];
    const elsewhere = Object.entries(CALL_SITE_VERDICTS)
      .filter(([, [verdict]]) => verdict === 'public-arm')
      .filter(([key]) => !PUBLIC_FILES.some((f) => key.startsWith(f)));

    expect(
      elsewhere.map(([k]) => k),
      '`public-arm` means the read MUST run with `app.workspace_id` unset, which is ' +
        'true of the public project pages and the public-request resolve and nothing ' +
        'else. Adding it elsewhere needs the policy to actually carry a public arm — ' +
        'check `pg_policies` first.',
    ).toEqual([]);
  });

  it('the scanner rules correctly on a fixture carrying every position', () => {
    // THE NEGATIVE CASE, as a permanent test rather than a one-off check, and run
    // against a fixture ROOT so proving the detector works can never leave a
    // stray unbound read in a real service.
    const root = 'tests/rls/__fixtures__/callSites';
    const byPosition = new Map(
      scanCallSites(root).map((c) => [`${c.read}@${c.line}`, c.position] as const),
    );
    const positions = [...byPosition.values()];

    // Pinned INDIVIDUALLY. One `toEqual` over the set would pass for the wrong
    // reason the day the scan returns nothing at all.
    expect(positions.filter((p) => p === 'receives-tx')).toHaveLength(2);
    expect(positions.filter((p) => p === 'in-context')).toHaveLength(1);
    expect(positions.filter((p) => p === 'in-bare-transaction')).toHaveLength(1);
    expect(positions.filter((p) => p === 'no-context')).toHaveLength(2);

    // And the three shapes that must NOT be reported at all:
    const reads = [...byPosition.keys()].map((k) => k.split('@')[0]);
    expect(reads, 'a read of a non-gated model has no policy to be blind to').not.toContain(
      'fixtureRepository.findGlobalSetting',
    );
    expect(reads, 'an UNBINDABLE read is the singleton scan`s class, not this one').not.toContain(
      'fixtureRepository.findWidgetUnbindable',
    );
    expect(bareTransactionSites(root)).toHaveLength(1);
  });

  it('the scanner actually finds the reads it is pointed at (a live negative)', () => {
    // A scanner that silently returns nothing passes forever. Pin that it walks
    // the repositories, resolves the schema, and finds known sites.
    const all = scanCallSites();
    expect(all.length).toBeGreaterThan(200);
    expect(all.some((c) => c.position === 'receives-tx')).toBe(true);
    expect(all.some((c) => c.position === 'no-context')).toBe(true);
  });

  it('the three defects found by hand are FIXED, and the scanner says so', () => {
    // These three were each discovered by a red suite during MOTIR-2796's run,
    // before this scanner existed (`notes.html` #266). Until MOTIR-2846 this test
    // asserted their PRESENCE — a detector that misses a bug we already know
    // about is not calibrated. All three are now bound, so the assertion inverts:
    // the calibration set becomes the regression guard, and a reappearance here
    // is the same defect coming back.
    //
    // The scanner's own detection power is pinned separately and does NOT depend
    // on these three: the synthetic fixture above proves it classifies each
    // position, and the live-negative proves it still walks the real tree.
    const declared = new Set(Object.keys(CALL_SITE_VERDICTS));
    const clean = (prefix: string, what: string): void => {
      expect(
        [...declared].filter((k) => k.startsWith(prefix)),
        what,
      ).toEqual([]);
      expect(
        unboundCallSites().filter((c) => c.file === prefix.replace('#', '')),
        what,
      ).toEqual([]);
    };

    // (1) backlogService — its gate reads sat outside its own withWorkspaceContext,
    //     which alone accounted for 49 failures in tests/integration/sprints.
    clean('lib/services/backlogService.ts#', 'backlogService is bound (MOTIR-2846)');

    // (2) workItemsService.updateStatus — a bare `db.$transaction`, which binds
    //     nothing. The whole FILE must now open no bare transaction: one is enough
    //     to darken every gated read inside it.
    expect(
      bareTransactionSites().filter((s) => s.file === 'lib/services/workItemsService.ts'),
      'workItemsService opens no bare transaction (MOTIR-2846)',
    ).toEqual([]);
    clean('lib/services/workItemsService.ts#', 'workItemsService call sites are bound');

    // (3) savedFilterSubscriptionsService — fixed earlier, under MOTIR-2805,
    //     because that card could not meet its own criterion without it.
    clean(
      'lib/services/savedFilterSubscriptionsService.ts#',
      'MOTIR-2805 bound this file; the scan should no longer report it',
    );
  });

  it('no site is left carrying an `unbound-call-site` verdict', () => {
    // The closing assertion of MOTIR-2846, and the reason the verdict kind stays
    // in the union rather than being deleted: it is how the NEXT one gets
    // adjudicated. What must never come back is a *standing* entry — a site
    // recorded as broken and left that way. Fix it, or give it a verdict that
    // says why it is not a defect.
    const open = Object.entries(CALL_SITE_VERDICTS)
      .filter(([, [verdict]]) => verdict === 'unbound-call-site')
      .map(([key]) => key);
    expect(
      open,
      'an `unbound-call-site` entry is a KNOWN defect parked in an allowlist. Bind the ' +
        'call (one argument, usually) rather than recording it here.',
    ).toEqual([]);
  });
});
