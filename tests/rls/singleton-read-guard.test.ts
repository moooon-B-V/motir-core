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
// This test is the thing that makes the fifth cheap. It does NOT decide whether a
// site is a bug — that needs the call sites, and three legitimate reasons to read
// unbound exist (a deliberately public read, a genuinely actorless one, and a
// caller that simply forgot). It asserts instead that **every site has been
// LOOKED AT**: the scanned set must equal the keys below, so adding a new
// singleton read of a tenant table fails the build until its author writes down
// which of the four it is.
//
// Same division of labour as `tenant-root-creation-rls.test.ts`'s
// `DELIBERATELY_UNGUARDED` map — the machine enumerates, a human adjudicates, and
// an unadjudicated addition is a red build rather than a silent one.
//
// ⚠️ WHY SO MANY ARE STILL `unreviewed`, AND WHY THAT IS NOT A SHRUG.
// A verdict needs evidence, and for most of these the evidence does not exist yet.
// `public` in particular cannot be earned by reading the code: it is the claim that
// the table's PUBLIC policy arm (MOTIR-2684) admits the row, and the only thing
// that can settle it is the public-projects suite passing under the app role —
// which it cannot do until its own fixtures are migrated (batch 16, MOTIR-2750).
// Measured 2026-08-12: `TEST_DB_APP_ROLE=1 vitest run tests/publicProjects` is red
// on fixture-entered failures, so a `public` verdict written today would be a guess
// wearing a citation. The honest state is `unreviewed` plus the ratchet below.
//
// So the verdicts land as the fixture batches land, and the RATCHET is what stops
// this from decaying: the count may fall, never rise. Rewriting the ceiling upward
// to make a build pass is the one edit this file exists to prevent.
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

  // ── unreviewed ────────────────────────────────────────────────────────────
  // Blocked on the fixture batches, per the header. MOTIR-2784 carries the sweep.
  'componentRepository.ts#listByProject': ['unreviewed', 'MOTIR-2784'],
  'customFieldDefinitionRepository.ts#listWithValuesForWorkItem': ['unreviewed', 'MOTIR-2784'],
  'dashboardRepository.ts#listVisible': ['unreviewed', 'MOTIR-2784'],
  'deviceCodeRepository.ts#findByUserCodeForRead': ['unreviewed', 'MOTIR-2784'],
  'githubRepoRepository.ts#findConnectedByName': ['unreviewed', 'MOTIR-2784'],
  'importRepository.ts#findCompletedForProject': ['unreviewed', 'MOTIR-2784'],
  'labelRepository.ts#findByIds': ['unreviewed', 'MOTIR-2784'],
  'labelRepository.ts#searchByPrefix': ['unreviewed', 'MOTIR-2784'],
  'organizationMembershipRepository.ts#findByOrgAndUser': ['unreviewed', 'MOTIR-2775'],
  'organizationRepository.ts#findById': ['unreviewed', 'MOTIR-2775'],
  'organizationRepository.ts#findBySlug': ['unreviewed', 'MOTIR-2775'],
  'organizationRepository.ts#findCapContext': ['unreviewed', 'MOTIR-2784'],
  'planRepository.ts#findBySourceJobId': ['unreviewed', 'MOTIR-2784'],
  'projectRepository.ts#findAllByIdentifier': ['unreviewed', 'MOTIR-2784'],
  'projectRepository.ts#findBySlug': ['unreviewed', 'MOTIR-2784, no caller anywhere'],
  'projectRepository.ts#findPublicByIdentifier': ['unreviewed', 'MOTIR-2784, public arm'],
  'projectRepository.ts#listPublic': ['unreviewed', 'MOTIR-2784, public arm'],
  'projectRepository.ts#listPublicDirectory': ['unreviewed', 'MOTIR-2784, public arm'],
  'projectRepository.ts#listPublicDirectoryRanked': ['unreviewed', 'MOTIR-2784, public arm'],
  'publicRequestVoteRepository.ts#sumUpvotesByProjects': ['unreviewed', 'MOTIR-2784, public arm'],
  'savedFilterRepository.ts#countVisible': ['unreviewed', 'MOTIR-2784'],
  'savedFilterRepository.ts#listPage': ['unreviewed', 'MOTIR-2784'],
  'savedFilterSubscriptionRepository.ts#countByFilter': ['unreviewed', 'MOTIR-2784'],
  'sprintReportEntryRepository.ts#countAddedAfterStart': ['unreviewed', 'MOTIR-2784'],
  'sprintReportEntryRepository.ts#countByCompletion': ['unreviewed', 'MOTIR-2784'],
  'sprintReportEntryRepository.ts#findByCompletion': ['unreviewed', 'MOTIR-2784'],
  'sprintReportEntryRepository.ts#sumPointsByCompletion': ['unreviewed', 'MOTIR-2784'],
  'sprintRepository.ts#findByIds': ['unreviewed', 'MOTIR-2784'],
  'workItemLinkRepository.ts#findBlockedByEdges': ['unreviewed', 'MOTIR-2784'],
  'workItemLinkRepository.ts#findBlockedEdgesForItems': ['unreviewed', 'MOTIR-2784'],
  'workItemLinkRepository.ts#findBlockerEdgesForItems': ['unreviewed', 'MOTIR-2784'],
  'workItemLinkRepository.ts#findBlockerSessionBranchesForItems': ['unreviewed', 'MOTIR-2784'],
  'workItemLinkRepository.ts#findBlockerStates': ['unreviewed', 'MOTIR-2784'],
  'workItemLinkRepository.ts#findBlockerStatesForItems': ['unreviewed', 'MOTIR-2784'],
  'workItemLinkRepository.ts#findByFromItem': ['unreviewed', 'MOTIR-2784'],
  'workItemLinkRepository.ts#findByToItem': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#aggregateBoardLanesByAssignee': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#aggregateBoardLanesByEpic': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#aggregateBoardLanesByPriority': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#aggregateCreatedByBucket': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#aggregateDistribution': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#aggregateWorkloadByAssignee': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#countPublicRoadmapSubmitted': ['unreviewed', 'MOTIR-2784, public arm'],
  'workItemRepository.ts#findAllByProjectForValidity': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#findAncestorIdsForItems': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#findBoundedSubtree': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#findByIds': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#findBySessionBranch': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#findChildrenCreatedAfter': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#findChildrenForItems': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#findDescriptionsByIds': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#findEpicAncestors': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#findExpandableStubs': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#findPublicRequestMatches': ['unreviewed', 'MOTIR-2784, public arm'],
  'workItemRepository.ts#findPublicRoadmapByStatus': ['unreviewed', 'MOTIR-2784, public arm'],
  'workItemRepository.ts#findPublicRoadmapSubmitted': ['unreviewed', 'MOTIR-2784, public arm'],
  'workItemRepository.ts#findReadyCandidates': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#findReadyLayer': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#findRoadmapBlockerStubs': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#findSubtreeMembersForValidity': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#matchesAutomationCondition': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#maxActivityByProjects': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#quickSearch': ['unreviewed', 'MOTIR-2784'],
  'workItemRepository.ts#sumStartedForSprint': ['unreviewed', 'MOTIR-2784'],
  'workItemRevisionRepository.ts#aggregateAverageAgeByBucket': ['unreviewed', 'MOTIR-2784'],
  'workItemRevisionRepository.ts#aggregateNetResolvedByBucket': ['unreviewed', 'MOTIR-2784'],
  'workItemRevisionRepository.ts#aggregateResolutionTimeByBucket': ['unreviewed', 'MOTIR-2784'],
  'workItemRevisionRepository.ts#aggregateSprintCycleByDay': ['unreviewed', 'MOTIR-2784'],
  'workItemRevisionRepository.ts#countDisplayableByWorkItem': ['unreviewed', 'MOTIR-2784'],
  'workItemRevisionRepository.ts#findLatestIdsByWorkItemIds': ['unreviewed', 'MOTIR-2784'],
  'workspaceMembershipRepository.ts#findByUserAndWorkspace': ['unreviewed', 'MOTIR-2784'],
  'workspaceRepository.ts#findById': ['unreviewed', 'MOTIR-2784'],
  'workspaceRepository.ts#findBySlug': ['unreviewed', 'MOTIR-2784'],
};

/**
 * The ratchet. Pinned to the count measured when this guard shipped; MOTIR-2784
 * and the fixture batches drive it to zero.
 *
 * ⚠️ This number may only ever go DOWN. If a change makes this fail, the fix is to
 * adjudicate the site — never to raise the ceiling.
 */
const UNREVIEWED_CEILING = 73;

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
    expect(scanned.length).toBeGreaterThan(50);
    expect(scanned.map((r) => r.key)).toContain('workItemRepository.ts#quickSearch');
    // And that the `tx ?? db` fallback is genuinely excluded — `findStatuses` uses it,
    // so if this ever appears the scanner has stopped distinguishing bindable reads
    // from unbound ones and every verdict above is meaningless.
    expect(scanned.map((r) => r.key)).not.toContain('workflowsRepository.ts#findStatuses');
  });
});
