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
// ⚠️ TWO RATCHETS MEASURED DIFFERENT THINGS, AND CONFLATING THEM WOULD HAVE READ AS
// REPAIR. This is the one part of MOTIR-2789/2796 worth carrying forward, because the
// next person to add a ratchet here will face the same choice.
//
// The adjudication pass located every call site of all 69 unreviewed reads and inspected
// each enclosing service method for a context wrapper. `UNREVIEWED_CEILING` fell 69 -> 8
// in that single commit — and the product got no more correct, because what the pass
// produced was 55 reads now KNOWN to be broken under `motir_app` rather than unknown.
// `reportsService.ts` and `savedFiltersService.ts` carried ZERO context wrappers in the
// whole file; `boardsService.ts` and `workItemsService.ts` had them only around WRITE
// paths. That is the shape of an entire READ surface which had never needed a binding,
// because CI and production both ran a BYPASSRLS role.
//
// So a SECOND ratchet was added — `UNBOUND_READ_PATH_CEILING` — precisely so the
// knowledge number could not be quoted as the correctness number. `unreviewed` measures
// whether anyone LOOKED, and can be lowered by writing a verdict. The unbound count
// measured whether the reads WORK, and could only be lowered by a service actually
// binding them.
//
// MOTIR-2796 drove that second count 55 -> 0, so MOTIR-2814 retired it: a ratchet with
// no members is a number that invites editing, where a set-equality assertion cannot be
// nudged. The `unbound-read-path` verdict is gone with it. What replaces it is stricter,
// not weaker — a NEW unbound read of a policy-gated table has no verdict to earn, so the
// set-equality test below fails until it is bound or explained. Its sibling
// `tests/rls/call-site-guard.test.ts` holds the other axis (a bindable read whose caller
// passes nothing) and carries its own two ratchets, both at their floor.
//
// `public` remains the one verdict that cannot be earned by reading code: it is the claim
// that MOTIR-2684's public policy ARM admits the row, and only the public-projects suite
// passing under the app role can settle it. The 8 `unreviewed` sites below are all of that
// kind, and they belong to MOTIR-2789 — NOT to this story.
//
// `UNREVIEWED_CEILING` may fall, never rise. Rewriting a ceiling upward to make a build
// pass is the one edit this file exists to prevent.
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
  /**
   * The read runs UNBOUND on purpose, and a PUBLIC POLICY ARM admits its rows.
   *
   * ⚠️ THE ONE VERDICT THAT CANNOT BE EARNED BY READING CODE — this file's header
   * says so, and it was true until MOTIR-2811. It is the claim that a specific
   * policy admits the row with NO GUC bound, so it needs the policy to exist and
   * a test to have watched it work. Both halves are named in the reason.
   */
  | 'public'
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

  // ── operator-script (2) ───────────────────────────────────────────────────
  // `scripts/stampOnboardingRan.ts` is the sole caller of both. It searches for a
  // project key ACROSS workspaces — that is the point, since it refuses an
  // ambiguous match rather than guessing — so there is no single tenant to bind
  // and no policy arm for a cross-tenant search (nor should there be).
  //
  // ⚠️ THE VERDICT IS NO LONGER CONDITIONAL. It used to carry a caveat: the
  // script's header claimed non-bypass safety it did not have, so under
  // `motir_app` these returned nothing and it reported the project missing.
  // MOTIR-2813 closed that two ways — the header now scopes its claim to the
  // WRITE, and `assertOperatorConnection()` reads `pg_roles.rolbypassrls` and
  // refuses LOUDLY rather than answering wrongly. `workspaceRepository.findBySlug`
  // left this list entirely: the `--workspace` arm binds `app.bootstrap_slug`
  // (`withBootstrapSlugContext`) and now works under EITHER role.
  'projectRepository.ts#findAllByIdentifier': [
    'operator-script',
    'stampOnboardingRan — cross-tenant search, refused loudly under motir_app',
  ],
  'projectRepository.ts#findBySlug': [
    'operator-script',
    'stampOnboardingRan — cross-tenant search, refused loudly under motir_app',
  ],

  // ── test-only (0) — RETIRED, not adjudicated ──────────────────────────────
  // MOTIR-2812 DELETED all three: `workItemRepository.findReadyCandidates`,
  // `workspaceMembershipRepository.findByUserAndWorkspace` and
  // `projectRepository.listPublicDirectory`. Each had zero production callers
  // across `app`, `lib`, `scripts` AND `packages`, and each was a live
  // vacuous-pass risk — under `motir_app` they returned nothing, so a test using
  // one as an EXISTENCE check did not go red, it went quietly meaningless.
  //
  // Deleting a site is a legitimate way to leave this list (the MOTIR-2775
  // precedent). No entry replaces them: a read that no longer exists needs no
  // verdict, and `tests/permissions/membershipGateRouting.test.ts` is now a
  // TOMBSTONE that fails the build if the sharpest of the three comes back.

  // ── public (1) ────────────────────────────────────────────────────────────
  // The project square's demand counts, read by an anonymous visitor across many
  // projects in many workspaces. There is no workspace to bind — inventing one
  // would presume the answer the page computes — so MOTIR-2811 gave the table a
  // public SELECT arm instead of a `tx`. The FIRST verdict of this kind: the
  // header's "a `public` verdict today would be a guess wearing a citation" held
  // until the arm and its tests existed together.
  'publicRequestVoteRepository.ts#sumUpvotesByProjects': [
    'public',
    'public_request_vote_public_project_read (20260813210000) · publicProjectAccess.test',
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
// ⚠️ READ THIS BEFORE CELEBRATING THE DROP. 69 -> 8 was a gain in KNOWLEDGE, not in
// correctness — see the two-ratchets note in this file's header, which is the whole
// reason a second ratchet existed. Reporting the unreviewed count alone would have
// misrepresented that commit.
//
// 73 -> 70: MOTIR-2775 RETIRED three zero-caller org-tier singleton reads
// (`organizationRepository.findById` / `findBySlug`,
// `organizationMembershipRepository.findByOrgAndUser`) rather than adjudicating them.
// Deleting a site is a legitimate way to lower this number — the point of the ratchet is
// that the count of UNJUDGED reads falls, and a read that no longer exists needs no
// verdict. Lowered in the same commit as the deletion, which is what the guard asks for.

// ── The retired second ratchet (MOTIR-2814) ─────────────────────────────────
// `UNBOUND_READ_PATH_CEILING` lived here and measured the reads confirmed BROKEN under
// `motir_app`. MOTIR-2796 walked it 55 -> 0 across fifteen cards — savedFilters,
// reports, sprints + estimation, boards, `findByIds` and its 13 call sites, activity,
// workItems (link edges, then trees/search/decorations), plan validity + staleness, the
// nine single-read services, migrate-onboarding, and a public SELECT arm for
// `public_request_vote`. With the class empty the constant is gone: the set-equality test
// above is the stronger guard, because a new unbound read has no verdict to earn and
// fails the build outright rather than fitting under a ceiling.
//
// ⚠️ The constant sat STALE at 14 for the last four of those cards. Their messages each
// claimed a step (14 -> 11 -> 3 -> 1 -> 0); the VERDICTS entries were duly removed, but
// the literal was not edited, and `0 <= 14` passes silently. That is the failure mode a
// ceiling has and a set-equality assertion does not, and it is a second reason this one
// is retired rather than pinned at zero.

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
    // fails instead of passing forever. It moves DOWN as reads become bindable —
    // 51 before MOTIR-2807, 19 after MOTIR-2809 — so it is kept comfortably below
    // the live count rather than pinned to it, and lowered when a card takes the
    // population past it.
    expect(scanned.length).toBeGreaterThan(10);
    // A KNOWN site, chosen because it SURVIVES this story by design:
    // `rateLimitCounterRepository.countAllUnsafe` carries the `pre-auth` verdict
    // (no tenant exists at read time), so nothing will bind it away. Two earlier
    // canaries — `quickSearch`, then `matchesAutomationCondition` — were each
    // bound by the very next card, which is the wrong property for a canary.
    expect(scanned.map((r) => r.key)).toContain('rateLimitCounterRepository.ts#countAllUnsafe');
    // And that the `tx ?? db` fallback is genuinely excluded — `findStatuses` uses it,
    // so if this ever appears the scanner has stopped distinguishing bindable reads
    // from unbound ones and every verdict above is meaningless.
    expect(scanned.map((r) => r.key)).not.toContain('workflowsRepository.ts#findStatuses');
  });
});
