import { describe, expect, it } from 'vitest';
import { scanSingletonReads } from './singletonReadScan';

// The singleton-read GUARD (MOTIR-2784).
//
// `singletonReadScan.ts` enumerates every repository method that reads the
// `@/lib/db` singleton, with no `tx ?? db` fallback, against a policy-gated table.
// Such a read runs outside any bound transaction, so the RLS policy sees NULL and
// it returns ZERO ROWS WITHOUT RAISING — the caller then reports "missing" for a
// row that exists. The class has been found FOUR times (MOTIR-2569, MOTIR-2685,
// MOTIR-2774's three sites, and this card's two), every time by accident, from a
// suite run under TEST_DB_APP_ROLE=1 rather than from anyone reading the code.
//
// This test is the thing that makes the fifth cheap. The SCANNER does not decide whether
// a site is a bug — that needs the call sites, which is why the verdicts live here and
// not in it. It asserts instead that **every site has been LOOKED AT**: the scanned set
// must equal the keys below, so adding a new singleton read of a tenant table fails the
// build until its author writes down which verdict it earns.
//
// Same division of labour as `tenant-root-creation-rls.test.ts`'s
// `DELIBERATELY_UNGUARDED` map — the machine enumerates, a human adjudicates, and
// an unadjudicated addition is a red build rather than a silent one.
//
// ⚠️ WHAT THE ADJUDICATION FOUND (MOTIR-2789), AND WHY THE HEADLINE NUMBER MISLEADS.
// The 69 unreviewed sites were adjudicated by locating EVERY call site of every read
// and inspecting its enclosing service method for a context wrapper. The result was
// not 69 scattered oversights:
//
//   • 55 are `unbound-read-path` — confirmed unbound, therefore confirmed BROKEN under
//     `motir_app`. `reportsService.ts` and `savedFiltersService.ts` contain ZERO context
//     wrappers in the entire file; `boardsService.ts` and `workItemsService.ts` have them
//     only around their WRITE paths. This is the shape of the whole READ surface, which
//     has never needed a binding because CI and production both run a BYPASSRLS role.
//   •  3 are `operator-script`, •  3 are `test-only` (vacuous-pass risk),
//   •  8 remain `unreviewed` — the public-surface reads, below.
//
// So `UNREVIEWED_CEILING` fell 69 → 8 while the product got no more correct. That is
// why there are now TWO ratchets: `unreviewed` measures whether anyone has LOOKED, and
// `UNBOUND_READ_PATH_CEILING` measures whether the reads WORK. Quoting the first alone
// would turn a diagnosis into a false claim of repair. The second falls only when a
// service actually binds its reads (MOTIR-2796), never by writing a verdict.
//
// `public` remains the one verdict that still cannot be earned by reading code: it is the
// claim that MOTIR-2684's public policy ARM admits the row, and only the public-projects
// suite passing under the app role can settle it. That suite is at 23 failures (from 33),
// so a `public` verdict today would be a guess wearing a citation.
//
// Both ratchets may fall, never rise. Rewriting a ceiling upward to make a build pass is
// the one edit this file exists to prevent.
//
// (It earned its keep before it shipped: the first run of this guard failed on four
// sites its own author had missed while transcribing the list by hand, and on two
// stale entries for reads the same card had just bound. A hand-maintained list of
// seventy-five is wrong the moment it is written; that is the argument for having
// the machine hold the enumeration and the human hold only the verdicts.)

/** Why a singleton read of a policy-gated table is acceptable — or is not yet judged. */
type Verdict =
  /** Fixed: the read now takes the transaction its caller had already bound. */
  | 'bound'
  /** No tenant exists at read time; there is nothing to bind. */
  | 'pre-auth'
  /**
   * CONFIRMED UNBOUND, and confirmed BROKEN under `motir_app` (MOTIR-2789).
   * The read filters by `workspaceId` in its own WHERE clause — the call site
   * passes `ctx.workspaceId` — but NOTHING on the path binds the GUC the policy
   * reads, so under the non-bypass role it returns zero rows and raises nothing.
   * These are not oversights at the repository: the fix is one layer up, at the
   * service method that owns the read, and it is the same fix for every site in
   * a given service. The value names that service, because that is the unit of
   * work. Tracked by MOTIR-2796.
   */
  | 'unbound-read-path'
  /**
   * The only caller is a `scripts/` maintenance tool, which runs on the
   * OPERATOR's connection (the migration/owner role), not the request-path
   * `motir_app` role. Nothing to bind and nothing to fix — but see the note on
   * `stampOnboardingRan` below, because the boundary is narrower than it looks.
   */
  | 'operator-script'
  /**
   * No production caller at all: the read survives only because tests still call
   * it. Under the app role it returns zero rows, so any test using it as an
   * EXISTENCE check passes VACUOUSLY. Retire the read and move the tests to
   * `adminDb` — the MOTIR-2775 disposition.
   */
  | 'test-only'
  /** Enumerated, not yet adjudicated. Only ever to be REMOVED from this file. */
  | 'unreviewed';

const VERDICTS: Record<string, readonly [Verdict, string]> = {
  // ── pre-auth: the shared rate limiter ─────────────────────────────────────
  // The surfaces it protects — sign-in, sign-up, password reset, public writes —
  // are limited BEFORE any workspace is known, which is why the table is in
  // `tenant-root-creation-rls.test.ts`'s DELIBERATELY_UNGUARDED map and reasoned
  // out in docs/decisions/production-service-stack.md §7. Every caller component
  // in `key` is SHA-256 hashed, so there is no tenant content to scope.
  'rateLimitCounterRepository.ts#countAllUnsafe': ['pre-auth', 'no tenant exists at write time'],
  'rateLimitCounterRepository.ts#findCountUnsafe': ['pre-auth', 'no tenant exists at write time'],

  // ── operator-script (3) ───────────────────────────────────────────────────
  // `scripts/stampOnboardingRan.ts` is the sole caller of all three. It resolves a
  // workspace by SLUG and a project by KEY across workspaces (it refuses an ambiguous
  // match rather than guessing), so there is no single tenant to bind — the read is
  // cross-tenant BY DESIGN, which is exactly why it belongs to an operator and not to
  // a request path.
  //
  // ⚠️ The script's own header claims its write "passes under the non-bypass
  // `motir_app` role in production" — true of the WRITE, which `withWorkspaceContext`
  // binds, but NOT of these three resolves above it. Run that script on a `motir_app`
  // connection and `findBySlug` returns null, so it reports `workspace_not_found` for a
  // workspace that exists and stamps nothing. The verdict here is therefore conditional
  // on the operator posture, and MOTIR-2796 carries making that explicit at the seam
  // (`workspace_visible_bootstrap`, the `app.bootstrap_slug` arm, admits exactly a
  // one-slug read and is the sanctioned mechanism if it ever needs to run as the app).
  'projectRepository.ts#findAllByIdentifier': ['operator-script', 'stampOnboardingRan'],
  'projectRepository.ts#findBySlug': ['operator-script', 'stampOnboardingRan'],
  'workspaceRepository.ts#findBySlug': ['operator-script', 'stampOnboardingRan'],

  // ── test-only (3) ─────────────────────────────────────────────────────────
  // Zero production callers; only tests keep them alive. `findReadyCandidates` was
  // REPLACED by `findReadyLayer` (see its own docstring, and the note at
  // workItemRepository.ts:1083 — "the read that replaces the whole-table
  // findReadyCandidates scan"), so two suites are pinning the behaviour of a read the
  // product no longer performs. `findByUserAndWorkspace` has seven test consumers and a
  // test that documents it "reads through the `db`" — the same shape MOTIR-2775 retired
  // rather than adjudicated. Under the app role each returns zero rows, so a test using
  // one as an existence check passes VACUOUSLY, which is the worst of the failure modes
  // here: it does not go red, it goes quietly meaningless. MOTIR-2796 retires them.
  'projectRepository.ts#listPublicDirectory': ['test-only', 'projectSquareDirectory.test'],
  'workItemRepository.ts#findReadyCandidates': ['test-only', 'superseded by findReadyLayer'],
  'workspaceMembershipRepository.ts#findByUserAndWorkspace': [
    'test-only',
    '7 suites, MOTIR-2775 shape',
  ],

  // ── unbound-read-path (14) ────────────────────────────────────────────────
  // Measured, not guessed: every call site of every read below was located and its
  // enclosing service method inspected for a context wrapper. NONE has one.
  // `reportsService.ts` and `savedFiltersService.ts` contain ZERO context wrappers in
  // the entire file; `boardsService.ts` and `workItemsService.ts` have them only around
  // their WRITE paths, and these reads sit outside every one.
  //
  // So this is not fifty-five separate oversights — it is the shape of the whole
  // READ surface, which has never needed a binding because CI and production both run
  // a BYPASSRLS role (MOTIR-2515 is the cutover that ends that). The value names the
  // owning service because the fix is per-SERVICE, not per-read: open
  // `withWorkspaceServiceContext` at the service-method boundary and thread `tx` down.
  // Grouped by service, that is ~20 units of work, which is why MOTIR-2796 is a story
  // and not another sweep card.
  'componentRepository.ts#listByProject': ['unbound-read-path', 'componentsService'],
  'dashboardRepository.ts#listVisible': ['unbound-read-path', 'dashboardsService'],
  'deviceCodeRepository.ts#findByUserCodeForRead': ['unbound-read-path', 'cliDeviceService'],
  'githubRepoRepository.ts#findConnectedByName': ['unbound-read-path', 'oidcAuth'],
  'importRepository.ts#findCompletedForProject': ['unbound-read-path', 'migrateOnboardingService'],
  'labelRepository.ts#searchByPrefix': ['unbound-read-path', 'labelsService'],
  'organizationRepository.ts#findCapContext': ['unbound-read-path', 'entitlementsService'],
  'planRepository.ts#findBySourceJobId': ['unbound-read-path', 'migrateOnboardingService'],
  'publicRequestVoteRepository.ts#sumUpvotesByProjects': [
    'unbound-read-path',
    'projectSquareService',
  ],
  'workItemRepository.ts#findAllByProjectForValidity': ['unbound-read-path', 'planValidityService'],
  'workItemRepository.ts#findChildrenCreatedAfter': ['unbound-read-path', 'planStalenessService'],
  'workItemRepository.ts#findDescriptionsByIds': ['unbound-read-path', 'planValidityService'],
  'workItemRepository.ts#matchesAutomationCondition': [
    'unbound-read-path',
    'automationEngineService',
  ],
  'workItemRevisionRepository.ts#findLatestIdsByWorkItemIds': [
    'unbound-read-path',
    'aiBoundaryService',
  ],

  // ── unreviewed (8) ────────────────────────────────────────────────────────
  // The public-surface reads, and the ONE category the header's argument still binds:
  // a `public` verdict is the claim that MOTIR-2684's public policy ARM admits the row,
  // and only a green public-projects suite under the app role can settle it. That suite
  // is at 23 failures (down from 33), so the verdict is not yet earnable — writing one
  // today would be, in the header's words, a guess wearing a citation.
  //
  // Two facts already narrow it. Against `pg_policies`, ONLY `project` and `work_item`
  // carry public arms — `board`, `board_column`, `board_column_status`,
  // `workflow_status`, `comment`, `public_request_vote` and `work_item_link` do not — and
  // a direct probe as `motir_app` with NO GUC bound returns `projects_visible=1`,
  // `items_visible=1`, so the two arms that exist do work. The reads below all target
  // `project` or `work_item`, which is why they are plausibly `public` rather than
  // plausibly broken; the suite has to say so before it is written down.
  'projectRepository.ts#findPublicByIdentifier': [
    'unreviewed',
    'public arm, needs the green suite',
  ],
  'projectRepository.ts#listPublic': ['unreviewed', 'public arm, needs the green suite'],
  'projectRepository.ts#listPublicDirectoryRanked': [
    'unreviewed',
    'public arm, needs the green suite',
  ],
  'workItemRepository.ts#countPublicRoadmapSubmitted': [
    'unreviewed',
    'public arm, needs the green suite',
  ],
  'workItemRepository.ts#findPublicRequestMatches': [
    'unreviewed',
    'public arm, needs the green suite',
  ],
  'workItemRepository.ts#findPublicRoadmapByStatus': [
    'unreviewed',
    'public arm, needs the green suite',
  ],
  'workItemRepository.ts#findPublicRoadmapSubmitted': [
    'unreviewed',
    'public arm, needs the green suite',
  ],
  'workItemRepository.ts#maxActivityByProjects': [
    'unreviewed',
    'public arm, needs the green suite',
  ],
};

/**
 * The ratchet. Pinned to the count measured when this guard shipped; MOTIR-2784
 * and the fixture batches drive it to zero.
 *
 * ⚠️ This number may only ever go DOWN. If a change makes this fail, the fix is to
 * adjudicate the site — never to raise the ceiling.
 */
const UNREVIEWED_CEILING = 8;
// 70 -> 69: MOTIR-2789 made `workspaceRepository.findById` bindable and bound the public
// board/stats reads that were its callers.
// 69 -> 8: MOTIR-2789 adjudicated the rest. NOT by fixing 61 reads — by locating every
// call site, finding that none binds a context, and saying so in a verdict that names the
// owning service. The eight that remain are the public-surface reads, which need a green
// public-projects suite before a `public` verdict is honest rather than assumed.
//
// ⚠️ READ THIS BEFORE CELEBRATING THE DROP. 69 -> 8 is a gain in KNOWLEDGE, not in
// correctness: 55 reads are now known-broken-under-`motir_app` instead of unknown, and
// `UNBOUND_READ_PATH_CEILING` below is the number that has to fall for the product to
// actually work. Reporting the unreviewed count alone would misrepresent this commit.
//
// 73 -> 70: MOTIR-2775 RETIRED three zero-caller org-tier singleton reads
// (`organizationRepository.findById` / `findBySlug`,
// `organizationMembershipRepository.findByOrgAndUser`) rather than adjudicating them.
// Deleting a site is a legitimate way to lower this number — the point of the ratchet is
// that the count of UNJUDGED reads falls, and a read that no longer exists needs no
// verdict. Lowered in the same commit as the deletion, which is what the guard asks for.

/**
 * The second ratchet, and the one that measures the PRODUCT rather than the review.
 * Every read counted here is confirmed to return zero rows under `motir_app`; the
 * fix is per-service (MOTIR-2796), so this falls in steps of a service's worth.
 *
 * ⚠️ May only ever go DOWN — and unlike the unreviewed ceiling, it cannot be lowered
 * by writing a verdict. It falls only when a service actually binds its reads.
 *
 * 55 -> 52: MOTIR-2805 bound `savedFiltersService` — `listPage`, `countVisible` and
 * `countByFilter`. Lowered BY SUBTRACTION of this card's three, never restated as an
 * absolute: sibling cards edit this same line, and an absolute would discard theirs.
 * 52 -> 44: MOTIR-2800 bound `reportsService` — its eight aggregates, all raw SQL.
 * Same subtraction discipline.
 * 44 -> 39: MOTIR-2804 bound `sprintsService` + `estimationService` — the four
 * `sprint_report_entry` reads and the child rollup.
 * 39 -> 35: MOTIR-2801 bound `boardsService` — the three lane aggregates and the
 * epic-ancestor walk.
 * 35 -> 32: MOTIR-2807 made `workItemRepository.findByIds` bindable and bound its
 * 13 call sites; `sprintRepository.findByIds` and `workItemLinkRepository.
 * findByFromItem` came with it, because two of those call sites read the edge and
 * the batch together and binding one without the other fixes nothing.
 * 32 -> 31: `workItemLinkRepository.findByToItem`, the IN-edge mirror, for the
 * same reason.
 * 31 -> 30: MOTIR-2806 bound `activityService` — `countDisplayableByWorkItem`.
 * Its other named read, `sprintRepository.findByIds`, landed with MOTIR-2807,
 * which needed it for the same feed.
 * 30 -> 21: MOTIR-2802 bound `workItemsService`'s eight link-edge reads. Three
 * more came with them because they share a call site and binding half of a
 * contiguous run fixes nothing — `findBlockerEdgesForItems` (MOTIR-2808 owns its
 * other caller), `customFieldDefinitionRepository.listWithValuesForWorkItem`, and
 * the item-detail fan-out they sit in.
 * 21 -> 14: MOTIR-2803 bound the other half of `workItemsService` — the tree
 * walks, quick search, expandable stubs, the ready-layer descent and
 * `labelRepository.findByIds` — at every caller, including the three in
 * `sprintsService`, `autoPlanCadenceService` and `labelsService`.
 */
const UNBOUND_READ_PATH_CEILING = 14;

describe('singleton reads of policy-gated tables are all accounted for', () => {
  it('every scanned site has a verdict, and every verdict names a real site', () => {
    const scanned = scanSingletonReads()
      .map((r) => r.key)
      .sort();
    const declared = Object.keys(VERDICTS).sort();

    const undeclared = scanned.filter((k) => !declared.includes(k));
    const stale = declared.filter((k) => !scanned.includes(k));

    // Two separate messages, because the two failures need opposite fixes.
    expect(
      undeclared,
      'A repository method reads the `@/lib/db` singleton against a policy-gated ' +
        'table and is not in VERDICTS. Under the non-bypass role that read returns ' +
        'ZERO ROWS AND RAISES NOTHING. Decide which it is — pass the caller`s `tx` ' +
        '(`bound`), or add an entry saying why it needs no tenant — and add it here.',
    ).toEqual([]);
    expect(
      stale,
      'VERDICTS names a site the scanner no longer finds. If you bound or deleted ' +
        'the read, delete its entry too — a stale allowlist hides the next one.',
    ).toEqual([]);
  });

  it('the confirmed-unbound count only ever falls', () => {
    const unbound = Object.entries(VERDICTS)
      .filter(([, [verdict]]) => verdict === 'unbound-read-path')
      .map(([key]) => key);

    // The ratchet that actually tracks the product working. `unreviewed` falling means
    // someone LOOKED; this falling means a read that returned zero rows under
    // `motir_app` now returns its rows. MOTIR-2796 drives it to zero, service by
    // service — so it should fall in service-sized steps, not one read at a time.
    expect(
      unbound.length,
      `${unbound.length} reads are confirmed unbound under the app role (ceiling ` +
        `${UNBOUND_READ_PATH_CEILING}). If this ROSE, a new read joined an already-broken ` +
        'service — bind the service method rather than adding an entry. If it FELL, lower ' +
        'the ceiling in the same commit.',
    ).toBeLessThanOrEqual(UNBOUND_READ_PATH_CEILING);
  });

  it('every unbound-read-path verdict names the service that owns the fix', () => {
    // The value is the unit of work, not a comment: MOTIR-2796's children are cut by
    // SERVICE, so a verdict that says `?` or `MOTIR-xxxx` cannot be planned against and
    // would quietly drop that read from the story.
    const nameless = Object.entries(VERDICTS)
      .filter(([, [verdict]]) => verdict === 'unbound-read-path')
      .filter(([, [, reason]]) => !/Service$|^[a-z]\w*(Service|Auth)$/.test(reason))
      .map(([key, [, reason]]) => `${key} -> "${reason}"`);

    expect(
      nameless,
      'An `unbound-read-path` verdict must name the owning service (e.g. `reportsService`), ' +
        'because that is the unit MOTIR-2796 plans against.',
    ).toEqual([]);
  });

  it('the unreviewed count only ever falls', () => {
    const unreviewed = Object.entries(VERDICTS)
      .filter(([, [verdict]]) => verdict === 'unreviewed')
      .map(([key]) => key);

    expect(
      unreviewed.length,
      `${unreviewed.length} sites are still unreviewed (ceiling ${UNREVIEWED_CEILING}). ` +
        'If this failed because the count ROSE, adjudicate the site instead of raising ' +
        'the ceiling. If it fell, lower UNREVIEWED_CEILING to the new count in the same ' +
        'commit — that is what makes the progress durable.',
    ).toBeLessThanOrEqual(UNREVIEWED_CEILING);
  });

  it('the scanner rules correctly on a fixture with all five shapes', () => {
    // THE NEGATIVE CASE, as a permanent test rather than a one-off manual check.
    // A guard is only worth its allowlist if its detector is exercised in BOTH
    // directions, so the fixture carries one of each shape and this pins the verdict
    // on all five. Run against a fixture ROOT rather than by editing a real
    // repository, so proving the guard works can never leave a stray read behind.
    const root = 'tests/rls/__fixtures__/scanner';
    const keys = scanSingletonReads(root)
      .map((r) => r.key)
      .sort();

    expect(keys).toEqual([
      // (1) unbound read of a workspace-scoped model, and (4) raw SQL.
      'fixtureRepository.ts#findWidgetUnbound',
      'fixtureRepository.ts#rawUnbound',
    ]);

    // Spelled out individually, because `toEqual` above passing for the wrong
    // reason (an empty scan, a broken schema parse) is the failure mode that would
    // make this whole file decorative.
    expect(keys, 'a `tx ?? db` read is bindable, not unbound').not.toContain(
      'fixtureRepository.ts#findWidgetBindable',
    );
    expect(keys, 'a non-tenant model has no policy to be blind to').not.toContain(
      'fixtureRepository.ts#findGlobalSetting',
    );
    expect(keys, '$transaction is not a read').not.toContain('fixtureRepository.ts#notARead');
  });

  it('the scanner actually finds the reads it is pointed at (a live negative)', () => {
    // A guard whose scanner silently returns nothing passes forever. Pin that it
    // resolves the schema, walks the repositories, and finds a known site.
    const scanned = scanSingletonReads();
    // A floor, not a target: it exists so a scanner that silently returns nothing
    // fails instead of passing forever. It moves DOWN as reads become bindable
    // (MOTIR-2807 took the population 51 -> 48), so keep it comfortably below the
    // live count rather than pinned to it.
    expect(scanned.length).toBeGreaterThan(20);
    // A KNOWN site, chosen because it must survive the story: `matchesAutomationCondition`
    // is a `pre-auth`-adjacent read the automation engine issues and it stays on
    // the singleton for now. (`quickSearch` used to stand here and was bound by
    // MOTIR-2803 — a canary has to name something the scan still finds.)
    expect(scanned.map((r) => r.key)).toContain('workItemRepository.ts#matchesAutomationCondition');
    // And that the `tx ?? db` fallback is genuinely excluded — `findStatuses` uses it,
    // so if this ever appears the scanner has stopped distinguishing bindable reads
    // from unbound ones and every verdict above is meaningless.
    expect(scanned.map((r) => r.key)).not.toContain('workflowsRepository.ts#findStatuses');
  });
});
