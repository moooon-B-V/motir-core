import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import {
  bodyFilePaths,
  bodyReferenceSeverities,
  firstPostMergeCriterion,
  firstRepoStraddleCriterion,
  hasCriterionPathTokens,
  isOrderingCheckExempt,
  isSubsumptionCheckExempt,
  overGateSizing,
  selfBlockingDesignCriteria,
  type RepoCandidate,
} from '@/lib/workItems/proseVsGraph';
import { listConnectedRepoNames } from '@/lib/workItems/targetRepo';
import type { WorkItemProseAdvisoryDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The PROSE-vs-GRAPH advisory (MOTIR-1969) — the service half of the check whose
// pure string work lives in `lib/workItems/proseVsGraph.ts`.
//
// The rule. For a card, let **N** = the work items its `descriptionMd` NAMES via
// `motir:` link tokens and **E** = the work items it carries a `blocked_by` edge
// to. Emit one advisory per member of `N \ E` that is not `done` (and not the
// card itself, and not one of its ancestors).
//
// ⚠️ This is an ADDITION beside the existing finishability rules, NOT an
// extension of them. `gatingItemSatisfied` (lib/workItems/validity.ts) is a pure
// EDGE-AND-STATUS walk that never reads a description; this compares the NAMED
// set against the EDGE set. The next reader will otherwise try to route it
// through `gatingItemSatisfied` — it shares no input with it.
//
// ⚠️ ADVISORY, NEVER A BLOCKER. Advisories ride a SEPARATE channel in the
// verdict: `valid` / `blockers` (and the issue-detail `ready` / `openBlockers`)
// are byte-identical whether or not advisories are emitted, at BOTH severities.
// See `WorkItemProseAdvisoryDto` for why a gate here would be actively harmful.
//
// ⚠️ KNOWN BLIND SPOT — a `type: decision` card's deferrals are invisible to
// this check (`notes.html` #202). Its only input is `descriptionMd`, and a
// decision card's deliverable is a DOCUMENT in a repository; the deferrals it
// writes live there, outside the graph and outside every plan-side validator, so
// N is empty for exactly the reference that mattered (MOTIR-1980's §11 deferral
// against MOTIR-1918, whose own body never named it). That gap is covered by a
// planner RULE (MOTIR-1975 W3), NOT by this code — parsing ADRs from the plan
// side needs repo access and is a much larger surface. Documentation only; no
// behaviour follows from it.

/** One card whose body is scanned, plus the references that must NOT warn. */
export interface ProseAdvisorySubject {
  /** The scanned card's identifier — the advisory's `item`. */
  item: string;
  /** Its body. `null` / empty simply yields no references. */
  descriptionMd: string | null;
  /**
   * References that are legitimately edge-free: the card ITSELF, its ANCESTORS,
   * and everything already in its `blocked_by` set. Keyed the same way
   * {@link bodyReferenceSeverities} keys a reference — a real work-item id, or a
   * `planItem:<id>` temp-ref on the projected path.
   */
  exemptIds: ReadonlySet<string>;
  /**
   * The card's work TYPE and EXECUTOR — read ONLY by the ORDERING check's
   * exemption ({@link isOrderingCheckExempt}), never by the reference scan.
   * Required so every caller has to decide what it knows; `null` is a real
   * answer ("untyped", and therefore not exempt).
   */
  type: string | null;
  executor: string | null;
  /**
   * The repositories the card CARRIES — read ONLY by the REPO-STRADDLE check
   * (MOTIR-2177), which compares them against the repos its criteria name.
   *
   * **A SET since MOTIR-2728**, because a work item can legitimately ship in more
   * than one repository. The check is unchanged in intent: a criterion naming a
   * path in a repo the card does NOT carry is still the defect, and the empty
   * set still has its own arm ("unpinnable").
   *
   * EMPTY is a real answer, not a missing value, which is why it is required
   * rather than optional: a caller that has not decided what it knows would
   * otherwise silently take the unpinned branch. On the PROJECTED plan path a
   * not-yet-materialized `add` genuinely has no repo NAME — a proposal carries a
   * `targetRepoRole`, resolved to a name only at materialize — so `[]` there is
   * the truth, and the unpinnable arm is exactly the right question to ask of it.
   */
  targetRepos: readonly string[];
  /**
   * The card's real work-item id and filing instant — read ONLY by the
   * SUBSUMPTION check (MOTIR-2903), which needs both: the id to exclude the
   * card's OWN pull requests from the covering set, and `createdAt` as the
   * `since` for *"merged AFTER this card was filed"*.
   *
   * BOTH nullable, and both are a real answer rather than a missing value: on
   * the PROJECTED plan path a not-yet-materialized `add` has no row, no id and
   * no filing instant — and a card that does not exist yet cannot have been
   * subsumed, so the check is skipped for it rather than guessed at. Optional
   * (not required like the fields above) precisely because the projection has
   * nothing to decide here; every path with a stored row supplies them.
   */
  id?: string | null;
  createdAt?: Date | null;
  /**
   * The card's two sizing columns and whether it HOLDS children — the two sizing
   * columns read ONLY by the ESTIMATION-GATE check (MOTIR-3110), which compares
   * them against the gate's two ceilings for a childless `coding_agent` leaf, and
   * `hasChildren` read by that check AND by the SELF-BLOCKING-DESIGN check
   * (MOTIR-3178), whose entire scope test it is.
   *
   * Required for the same reason `targetRepos` is: every caller has to decide
   * what it knows. `null` on either number is a real answer (unestimated, which
   * crosses no ceiling), and `hasChildren` has no defensible default — guessing
   * `false` would report a container's rollup sizing as a leaf's run time, and
   * guessing `true` would mute the check for every caller that forgot it, which
   * is exactly the *"addressed to nobody"* failure MOTIR-2079 exists to end.
   */
  storyPoints: number | null;
  estimateMinutes: number | null;
  hasChildren: boolean;
}

/**
 * A reference the CALLER can already resolve without a DB read — the projected
 * path passes its whole in-project node set (real nodes AND not-yet-materialized
 * `planItem:<id>` adds), so a projected body can name a projected sibling.
 */
export interface ProseAdvisoryLocalRef {
  identifier: string;
  /** Raw workflow status key. */
  status: string;
  /** Terminal (`category = 'done'`) in the reference's OWN project. */
  done: boolean;
}

/**
 * Build the prose-vs-graph advisories for a set of scanned cards.
 *
 * Resolution, in order: a reference the caller supplied in `localRefs` is taken
 * from there; every other reference is resolved in ONE batched workspace read
 * and judged against ITS OWN project's terminal set (a reference can be
 * cross-project — finding #21).
 *
 * Dropped, never reported:
 *  - an exempt reference (self / ancestor / already `blocked_by`);
 *  - a `done` reference — the prose is satisfied, nothing to warn about;
 *  - a reference that resolves to NOTHING (a malformed or unknown id, a deleted
 *    or cross-workspace target) — body text, never an error;
 *  - a reference in a project the caller cannot BROWSE. It is omitted entirely
 *    rather than reported as an opaque row: naming it would leak the existence
 *    of an item the caller may not see. This reuses the exact
 *    `projectAccessService.filterBrowsable` gate the ref-chip resolver and
 *    auto-relate ride — not a new permission check.
 *
 * Returns a deterministically ordered list (by scanned card, then reference) so
 * the wire shape is stable.
 */
export async function buildProseVsGraphAdvisories(
  subjects: ProseAdvisorySubject[],
  ctx: ServiceContext,
  localRefs?: ReadonlyMap<string, ProseAdvisoryLocalRef>,
): Promise<WorkItemProseAdvisoryDto[]> {
  // Scan every body once, dropping the exempt references as we go.
  const scanned = subjects.map((s) => {
    const refs = new Map(bodyReferenceSeverities(s.descriptionMd));
    for (const id of s.exemptIds) refs.delete(id);
    return { item: s.item, refs, subject: s };
  });

  const unresolved = new Set<string>();
  for (const s of scanned) {
    for (const id of s.refs.keys()) {
      if (!localRefs?.has(id)) unresolved.add(id);
    }
  }

  // ONE batched read for everything the caller could not resolve locally, then
  // the browse gate, then per-project done-ness.
  const resolved = new Map<string, ProseAdvisoryLocalRef>();
  if (unresolved.size > 0) {
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdsInWorkspace([...unresolved], ctx.workspaceId, tx),
    );
    if (rows.length > 0) {
      const projects = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        projectRepository.findByWorkspace(ctx.workspaceId, tx),
      );
      const browsable = await projectAccessService.filterBrowsable(projects, ctx);
      const browsableProjectIds = new Set(browsable.map((p) => p.id));
      const visible = rows.filter((r) => browsableProjectIds.has(r.projectId));
      const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
        visible.map((r) => r.projectId),
        ctx.workspaceId,
      );
      for (const row of visible) {
        resolved.set(row.id, {
          identifier: row.identifier,
          status: row.status,
          done: terminalByProject.get(row.projectId)?.has(row.status) ?? false,
        });
      }
    }
  }

  // The REPO-STRADDLE check's second data source (MOTIR-2177): the workspace's
  // connected repositories, through the SAME `targetRepo` validation accepts, so
  // the two can never disagree about which names exist. ONE read for the whole
  // batch, and none at all for the common card whose criteria name no path —
  // `hasCriterionPathTokens` is pure and candidate-free precisely so this
  // advisory costs a query only when it could possibly fire.
  //
  // Read OUTSIDE any transaction, per `listConnectedRepoNames`' own contract (it
  // opens its own workspace-RLS context). Every caller of this function is a
  // read path; do not move it inside one.
  const repoCandidates: RepoCandidate[] = scanned.some((s) =>
    hasCriterionPathTokens(s.subject.descriptionMd),
  )
    ? await listConnectedRepoNames(ctx)
    : [];

  // The SUBSUMPTION check's data source (MOTIR-2903): the merged pull requests
  // whose diffs intersect ANY path ANY subject's body names. ONE read for the
  // whole batch — see `buildSubsumptionIndex` for why the per-subject clauses
  // (`since`, and the card's own pull requests) are applied in memory rather
  // than as N queries.
  const subsumption = await buildSubsumptionIndex(scanned, ctx);

  const advisories: WorkItemProseAdvisoryDto[] = [];
  for (const s of scanned) {
    // The SHAPE advisories first: they need no reference resolution at all (each
    // is a property of this body alone), so they are emitted even for a card
    // that names nothing. A card can carry BOTH — they are different defects.
    const ordering = orderingAdvisory(s.subject);
    if (ordering) advisories.push(ordering);
    const straddle = repoStraddleAdvisory(s.subject, repoCandidates);
    if (straddle) advisories.push(straddle);
    const sizing = sizingAdvisory(s.subject);
    if (sizing) advisories.push(sizing);
    const selfBlocking = selfBlockingDesignAdvisory(s.subject);
    if (selfBlocking) advisories.push(selfBlocking);
    const subsumed = subsumptionAdvisory(s.subject, subsumption);
    if (subsumed) advisories.push(subsumed);
    for (const [id, severity] of s.refs) {
      const ref = localRefs?.get(id) ?? resolved.get(id);
      if (!ref || ref.done) continue;
      advisories.push({
        item: s.item,
        referenced: ref.identifier,
        referencedStatus: ref.status,
        severity,
      });
    }
  }
  // Deterministic wire order: by scanned card, then SHAPE before reference (a
  // mis-shaped card is a fact about the card itself, and its remedy — cut here —
  // comes before any question about what it names), then by the family's own
  // key.
  advisories.sort(
    (a, b) =>
      a.item.localeCompare(b.item) ||
      familyRank(a) - familyRank(b) ||
      tieKey(a).localeCompare(tieKey(b)),
  );
  return advisories;
}

/**
 * SHAPE, then SUBSUMPTION, then REFERENCE within one card.
 *
 * Subsumption sits in the middle deliberately: like a shape finding it is a fact
 * about this card rather than a question about what it names, but unlike one its
 * remedy is *read the merged diff*, not *cut here* — and a reader who is about
 * to be told the card may already be built should hear that before a list of
 * references to go and verify.
 */
const familyRank = (a: WorkItemProseAdvisoryDto): number =>
  a.kind === 'shape' ? 0 : a.kind === 'subsumption' ? 1 : 2;

/**
 * The within-family tie-break key. A shape advisory has no far end, so it sorts
 * on its SEVERITY — stated rather than left to `Array.sort` stability, now that
 * one card can carry two of them (MOTIR-2177). A subsumption advisory sorts on
 * its PATH, which is the finding's own identity (at most one is emitted per
 * card, so this only has to be total, not discriminating).
 */
const tieKey = (a: WorkItemProseAdvisoryDto): string =>
  a.kind === 'shape' ? a.severity : a.kind === 'subsumption' ? a.path : a.referenced;

/**
 * The ORDERING advisory for ONE subject (MOTIR-2175) — gate 14's third axis.
 *
 * Pure: no reference resolution, no DB read, no dependency on the graph at all.
 * A card can carry this finding while naming nothing and having no edges, which
 * is precisely the case the reference scan cannot see — MOTIR-2162's criterion 5
 * was a defect about its OWN merge, so there was never a far end to resolve.
 */
function orderingAdvisory(subject: ProseAdvisorySubject): WorkItemProseAdvisoryDto | null {
  if (isOrderingCheckExempt(subject.type, subject.executor)) return null;
  const found = firstPostMergeCriterion(subject.descriptionMd);
  if (!found) return null;
  return {
    kind: 'shape',
    item: subject.item,
    severity: 'likely-ordering-violation',
    phrase: found.phrase,
    criterionIndex: found.criterionIndex,
  };
}

/**
 * The REPO-STRADDLE advisory for ONE subject (MOTIR-2177) — gate 1's repo
 * column, as a contradiction between two things the card itself asserts: its
 * `targetRepo` pin and the repo a criterion's path is discharged in.
 *
 * Pure once `candidates` is in hand. NO exemption predicate, deliberately —
 * unlike {@link orderingAdvisory}, whose `deploy` / `human` mute is the rule's
 * own remedy read back. Gate 1 has no such shape, so the boundary-contract card
 * fires knowingly (see `WorkItemProseRepoStraddleAdvisoryDto`).
 */
function repoStraddleAdvisory(
  subject: ProseAdvisorySubject,
  candidates: readonly RepoCandidate[],
): WorkItemProseAdvisoryDto | null {
  const found = firstRepoStraddleCriterion(subject.descriptionMd, subject.targetRepos, candidates);
  if (!found) return null;
  return {
    kind: 'shape',
    item: subject.item,
    severity: 'likely-repo-straddle',
    path: found.path,
    repo: found.repo,
    reason: found.reason,
    criterionIndex: found.criterionIndex,
  };
}

/**
 * THE ESTIMATION-GATE advisory for ONE subject (MOTIR-3110) — the card's own
 * sizing columns read against the gate's two ceilings.
 *
 * The cheapest check in the family: pure, no reference resolution, no DB read,
 * no prose parsing and no candidate set — two integers and an enum. Like
 * {@link orderingAdvisory} it fires on a card that names nothing and has no
 * edges, which is exactly the MOTIR-3068 fixture: a `bug` at 13 SP / 600 min
 * whose body had already NAMED the gate, quoted the threshold and chosen the
 * split axis, and which was `ready: true` and claimable anyway because the
 * output of that analysis went into a field the plan does not read
 * (`notes.html` #323).
 *
 * NO exemption predicate: the two exemptions this check has — a
 * non-`coding_agent` executor and a card that HOLDS children — are the gate's
 * own scope, applied inside {@link overGateSizing} where the numbers are.
 *
 * ⚠️ CORRECTED BY MOTIR-3271. This used to continue "…and unlike
 * {@link repoStraddleAdvisory} that is not a knowingly-accepted false positive
 * either". On the MINUTES arm it is one: `estimateMinutes` sums agent time and
 * CI time while the gate ceilings the agent run alone, so that arm is a proxy
 * with a real false-positive class (a short run behind a heavy CI leg). The
 * absent predicate is still the right call — see the DTO's corrected paragraph
 * for why a mute is the wrong remedy — but the reason given for it was not.
 */
function sizingAdvisory(subject: ProseAdvisorySubject): WorkItemProseAdvisoryDto | null {
  const found = overGateSizing({
    executor: subject.executor,
    hasChildren: subject.hasChildren,
    storyPoints: subject.storyPoints,
    estimateMinutes: subject.estimateMinutes,
  });
  if (!found) return null;
  return {
    kind: 'shape',
    item: subject.item,
    severity: 'likely-over-gate-sizing',
    threshold: found.threshold,
    storyPoints: found.storyPoints,
    estimateMinutes: found.estimateMinutes,
  };
}

/**
 * THE SELF-BLOCKING-DESIGN advisory for ONE subject (MOTIR-3178) — the design
 * gate's degenerate reading, asked of the card's own criteria.
 *
 * Pure prose plus ONE boolean: like {@link orderingAdvisory} it fires on a card
 * that names nothing and has no edges, which is exactly the MOTIR-3154 fixture —
 * a card whose design blocker was itself, so there was never a far end for the
 * reference scan to resolve.
 *
 * `hasChildren` is the whole scope test, and it is the gate's own scope rather
 * than a noise filter: a container's design child CAN be reviewed before its code
 * children run, which is the shape this check wants a card pushed into. So a
 * parent is never reported, whatever its criteria say — the finding is about a
 * LEAF that holds both halves.
 */
function selfBlockingDesignAdvisory(
  subject: ProseAdvisorySubject,
): WorkItemProseAdvisoryDto | null {
  if (subject.hasChildren) return null;
  const found = selfBlockingDesignCriteria(subject.descriptionMd);
  if (!found) return null;
  return {
    kind: 'shape',
    item: subject.item,
    severity: 'likely-self-blocking-design',
    designCriterionIndex: found.designCriterionIndex,
    surfaceCriterionIndex: found.surfaceCriterionIndex,
  };
}

/** One merged pull request, reduced to what the subsumption check reads. */
interface CoveringMerge {
  /** `owner/name#number` — where a reader goes to read the diff. */
  reference: string;
  /** The bare repo NAME, for the carried-repository-set narrowing. */
  repoName: string;
  title: string | null;
  mergedAt: Date;
  /** The work item this pull request is LINKED to, or null. */
  workItemId: string | null;
  /** The paths it touched, as a set, for a per-path hit test. */
  paths: ReadonlySet<string>;
}

/**
 * The merged pull requests that could cover ANY subject in this batch —
 * **ONE query for the whole batch**, not one per subject.
 *
 * `findMergedTouchingPaths` (MOTIR-2922) takes a single `since` and a single
 * `excludeWorkItemId`, and both of those are per-SUBJECT facts: each card has
 * its own filing instant, and each excludes its OWN pull requests. Issuing the
 * query per subject would be N round-trips for a `validate_work_item` over a
 * subtree of thirty cards. So the query is widened to the UNION of every
 * subject's paths with the EARLIEST `since` and no exclusion, and both
 * per-subject clauses are re-applied in memory in {@link subsumptionAdvisory} —
 * where they are exact comparisons on columns the rows already carry, not
 * approximations of the SQL.
 *
 * Costs NOTHING for the common batch: a body naming no file path contributes no
 * paths, and an empty union skips the read entirely — the same
 * pay-only-when-it-could-fire shape `hasCriterionPathTokens` gives the straddle
 * check.
 *
 * Read through `withWorkspaceServiceContext`, so the row set is the caller's
 * tenant by RLS and not merely by the `workspaceId` argument.
 */
async function buildSubsumptionIndex(
  scanned: ReadonlyArray<{ subject: ProseAdvisorySubject }>,
  ctx: ServiceContext,
): Promise<CoveringMerge[]> {
  const union = new Set<string>();
  for (const s of scanned) {
    if (s.subject.id == null || s.subject.createdAt == null) continue;
    if (isSubsumptionCheckExempt(s.subject.descriptionMd)) continue;
    for (const p of bodyFilePaths(s.subject.descriptionMd)) union.add(p);
  }
  if (union.size === 0) return [];

  const since = scanned.reduce<Date | null>((earliest, s) => {
    const at = s.subject.createdAt;
    if (at == null) return earliest;
    return earliest === null || at < earliest ? at : earliest;
  }, null);
  if (since === null) return [];

  const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    githubPullRequestRepository.findMergedTouchingPaths(
      ctx.workspaceId,
      [...union],
      since,
      null,
      tx,
    ),
  );
  return rows.flatMap((row) =>
    // `mergedAt` is nullable on the model (every row written before MOTIR-2922
    // has none), and the ordering clause is the half of the rule that cannot be
    // approximated — a row that cannot say WHEN it merged is dropped rather than
    // assumed recent. The query already filters on it, so this is the type
    // narrowing rather than a second policy.
    row.mergedAt === null
      ? []
      : [
          {
            reference: `${row.repo.owner}/${row.repo.name}#${row.number}`,
            repoName: row.repo.name,
            title: row.title,
            mergedAt: row.mergedAt,
            workItemId: row.workItemId,
            paths: new Set(row.changedPaths),
          },
        ],
  );
}

/**
 * The SUBSUMPTION advisory for ONE subject (MOTIR-2903) — *at least one path
 * this card's BODY names was touched by a merged pull request that is not this
 * card's own, and that merged after this card was filed*.
 *
 * Reports the FIRST covered path in DOCUMENT order, with the most recently
 * merged pull request that touched it. First-in-the-body rather than
 * first-by-date because the finding's job is to point a reader at the place to
 * start reading, and a body names its most load-bearing path first; most-recent
 * merge because that is the state of `main` the card would be rebuilt against.
 *
 * Two narrowings applied here rather than in SQL, both exact:
 *  - **The card's OWN pull requests never cover it.** A card whose branch is
 *    open is doing its work, not having it done for it.
 *  - **`mergedAt` must be strictly after the card's `createdAt`.** A merge that
 *    predates the card is the substrate it was written against, which is the
 *    opposite finding.
 *
 * And one narrowing that is precision rather than correctness: when the card
 * CARRIES a repository set, only merges in one of those repos count. A same-named
 * path in a repo the card does not ship in (`lib/db.ts` exists in three of them)
 * is a coincidence, not a covering merge. A card carrying an EMPTY set takes every
 * repo in the workspace, which is the honest reading of a card that has not said
 * where it ships — the same arm the repo-straddle check calls "unpinnable".
 *
 * ⚠️ The set, not `targetRepos[0]` (MOTIR-2728). A multi-repo card ships in every
 * member, so a merge in its SECOND repo covers its work exactly as one in its
 * first; reading only the head would make the finding depend on an ordering that
 * means "which repo dispatch routes to", not "which repos this card touches".
 */
function subsumptionAdvisory(
  subject: ProseAdvisorySubject,
  merges: readonly CoveringMerge[],
): WorkItemProseAdvisoryDto | null {
  if (merges.length === 0) return null;
  const { id, createdAt } = subject;
  if (id == null || createdAt == null) return null;
  if (isSubsumptionCheckExempt(subject.descriptionMd)) return null;

  const carried = new Set(subject.targetRepos.map((r) => r.toLowerCase()));
  const candidates = merges.filter(
    (m) =>
      m.workItemId !== id &&
      m.mergedAt > createdAt &&
      (carried.size === 0 || carried.has(m.repoName.toLowerCase())),
  );
  if (candidates.length === 0) return null;

  for (const path of bodyFilePaths(subject.descriptionMd)) {
    // `candidates` arrives ordered by `mergedAt` desc (the accessor's own
    // `orderBy`), so the first hit is the most recent merge touching this path.
    const covering = candidates.find((m) => m.paths.has(path));
    if (!covering) continue;
    return {
      kind: 'subsumption',
      item: subject.item,
      severity: 'likely-already-shipped',
      path,
      pullRequest: covering.reference,
      pullRequestTitle: covering.title,
      mergedAt: covering.mergedAt.toISOString(),
    };
  }
  return null;
}

/**
 * The DISPATCH-time advisories for ONE card (MOTIR-2079) — what the dispatch
 * prompt renders, what `motir run` / `motir next` warn about, and what
 * `claim_next_ready` returns.
 *
 * `validate_work_item` (MOTIR-1969) answers "is this SUBTREE finishable?" and
 * scans every not-done member. Dispatch asks a narrower question — "is the card
 * I am about to hand an agent consuming something that is not on `origin/main`
 * yet?" — so the subject is the single dispatched card, with the same exempt
 * rule its subtree twin uses: itself, its ANCESTORS (naming your own parent
 * Story or Epic is not a missing dependency), and everything already in its
 * `blocked_by` set.
 *
 * ⚠️ `likely-missing-edge` ONLY among the REFERENCE tier, and that filter lives
 * HERE so all three dispatch consumers agree by construction. The plain
 * `advisory` tier fires on any not-done item named ANYWHERE in a body — an
 * out-of-scope note, a superseded-by pointer, a sibling record card — which is a
 * useful signal when a human is reading a card and pure noise in front of an
 * agent about to branch. `likely-missing-edge` means the reference sits in the
 * card's own ACCEPTANCE CRITERIA, i.e. the card is closed against it.
 * `validate_work_item` remains the surface that reports BOTH tiers; nothing is
 * lost, only scoped.
 *
 * ⚠️ Every SHAPE advisory passes that filter (MOTIR-2175) — it is
 * dispatch-relevant BY CONSTRUCTION, and more so than any reference tier. The
 * agent about to branch is the one who physically cannot discharge a criterion
 * that turns on its own merge: its two moves are to stop half-done or to fake
 * the precondition, and both are rule violations. A shape advisory is already
 * scoped to the acceptance-criteria span, so there is no quieter tier of it to
 * filter out.
 *
 * ⚠️ NEVER A GATE — see {@link WorkItemProseAdvisoryDto}. The callers add this to
 * a field of their own; not one of them consults it when computing readiness.
 */
export async function buildDispatchProseAdvisories(
  item: {
    id: string;
    identifier: string;
    descriptionMd: string | null;
    type?: string | null;
    executor?: string | null;
    targetRepo?: string | null;
    targetRepos?: readonly string[];
    /**
     * The card's filing instant — the SUBSUMPTION check's `since` (MOTIR-2903).
     *
     * A `string` is accepted because `WorkItemDto.createdAt` is ISO text and
     * `dispatchPromptService` passes the whole DTO; `null` / absent means the
     * caller's row shape does not carry it (`ReadyItemDispatchDto` does not), in
     * which case this function READS it rather than skipping the check — see the
     * lazy read below. A dispatch surface that silently dropped the check
     * depending on which caller reached it is exactly the *"addressed to nobody"*
     * failure MOTIR-2079 exists to end.
     */
    createdAt?: Date | string | null;
    /**
     * The ESTIMATION-GATE check's two sizing columns (MOTIR-3110).
     *
     * `undefined` and `null` mean DIFFERENT things here, unlike on `createdAt`:
     * `null` is a real observation (the column is unestimated, which crosses no
     * ceiling) and `undefined` means the caller's row shape does not carry it —
     * `ReadyItemDispatchDto` does not — in which case this function READS them,
     * for the same reason the filing instant is read rather than skipped. A
     * check that fired for `dispatch_prompt` and not for `claim_next_ready`
     * would be the *"addressed to nobody"* failure in a new costume.
     */
    storyPoints?: number | null;
    estimateMinutes?: number | null;
  },
  ctx: ServiceContext,
): Promise<WorkItemProseAdvisoryDto[]> {
  const type = item.type ?? null;
  const executor = item.executor ?? null;
  // The SET when the caller has one, else the scalar as the one-element set it
  // means (MOTIR-2728) — so a caller that predates the set is never silently
  // treated as unpinned, which would swap the check's arm rather than skip it.
  const targetRepos: readonly string[] =
    item.targetRepos ?? (item.targetRepo ? [item.targetRepo] : []);
  // Cheap short-circuit on the common shape: a body with no reference, no
  // ordering phrase and no path-like token in its criteria needs neither the
  // ancestor walk nor the edge read. ALL THREE scans are pure, and all three
  // must be clear — a body naming nothing can still carry an ordering violation
  // (MOTIR-2162's did) or a repo straddle (MOTIR-2057's did).
  const namesNothing = bodyReferenceSeverities(item.descriptionMd).size === 0;
  const wellOrdered =
    isOrderingCheckExempt(type, executor) || firstPostMergeCriterion(item.descriptionMd) === null;
  const namesNoPath = !hasCriterionPathTokens(item.descriptionMd);
  // The SUBSUMPTION check's own clear-ness (MOTIR-2903). A FOURTH scan, and it
  // cannot ride on `namesNoPath`: that one is AC-scoped, and this check reads
  // the whole body — the path that catches the canonical fixture sits in its
  // Context refs, so a card with no path in its criteria can still be subsumed.
  const namesNoFile =
    isSubsumptionCheckExempt(item.descriptionMd) || bodyFilePaths(item.descriptionMd).length === 0;
  // The ESTIMATION-GATE check's own clear-ness (MOTIR-3110), and the FIFTH scan
  // — it reads no prose at all, so a body that names nothing can still be over
  // the gate. That is the MOTIR-3068 shape and the reason this term exists: a
  // card whose four string scans are clean and whose sizing is 13 SP / 600 min
  // would otherwise return `[]` here, one line before the check that catches it.
  //
  // `hasChildren: false` is not an assumption — it is the WIDER question, asked
  // first because the answer is free. Children only ever SUPPRESS the finding,
  // so a card that is not over the gate with children ignored is not over it
  // with children counted either, and the child-count read below is skipped
  // entirely. Only a card that WOULD fire pays for the row.
  const sizingCandidate =
    item.storyPoints === undefined || item.estimateMinutes === undefined
      ? executor === 'coding_agent'
      : overGateSizing({
          executor,
          hasChildren: false,
          storyPoints: item.storyPoints,
          estimateMinutes: item.estimateMinutes,
        }) !== null;
  // The SELF-BLOCKING-DESIGN check's own clear-ness (MOTIR-3178) — the SIXTH
  // scan, pure prose over the acceptance-criteria span. Children are ignored here
  // for the same reason the sizing term ignores them: they only ever SUPPRESS the
  // finding, so a body that is clear with children ignored is clear either way,
  // and no caller carries `hasChildren` on its row shape. Only a card that WOULD
  // fire pays for the row read below.
  const selfBlockingCandidate = selfBlockingDesignCriteria(item.descriptionMd) !== null;
  if (
    namesNothing &&
    wellOrdered &&
    namesNoPath &&
    namesNoFile &&
    !sizingCandidate &&
    !selfBlockingCandidate
  ) {
    return [];
  }

  // The SUBSUMPTION check's `since`, when the caller's row shape carries it.
  // `ReadyItemDispatchDto` does not, so it is read below — inside the batch that
  // is already open, and ONLY when the check could actually fire.
  const suppliedCreatedAt =
    item.createdAt == null
      ? null
      : item.createdAt instanceof Date
        ? item.createdAt
        : new Date(item.createdAt);

  const { ancestors, blockerLinks, rows } = await withWorkspaceServiceContext(
    ctx.workspaceId,
    async (tx) => ({
      ancestors: await workItemRepository.findAncestors(item.id, ctx.workspaceId, tx),
      blockerLinks: await workItemLinkRepository.findByFromItem(item.id, 'is_blocked_by', tx),
      rows:
        (suppliedCreatedAt === null && !namesNoFile) || sizingCandidate || selfBlockingCandidate
          ? await workItemRepository.findDescriptionsByIds([item.id], ctx.workspaceId, tx)
          : [],
    }),
  );
  const createdAt = suppliedCreatedAt ?? rows[0]?.createdAt ?? null;
  // The row is read ONLY when `sizingCandidate` or `selfBlockingCandidate`
  // (above), so its absence means neither check could fire — the fallbacks below
  // are the values that emit nothing, not a guess about a card nobody looked at.
  // `hasChildren` in particular falls back to `false`, which is safe precisely
  // because both checks that read it are SUPPRESSED by children and never
  // triggered by them.
  const storyPoints =
    item.storyPoints !== undefined ? item.storyPoints : (rows[0]?.storyPoints ?? null);
  const estimateMinutes =
    item.estimateMinutes !== undefined ? item.estimateMinutes : (rows[0]?.estimateMinutes ?? null);
  const hasChildren = rows[0]?.hasChildren ?? false;
  const exemptIds = new Set<string>([item.id]);
  for (const a of ancestors) exemptIds.add(a.id);
  for (const l of blockerLinks) exemptIds.add(l.toId);

  const advisories = await buildProseVsGraphAdvisories(
    [
      {
        item: item.identifier,
        descriptionMd: item.descriptionMd,
        exemptIds,
        type,
        executor,
        targetRepos,
        id: item.id,
        createdAt,
        storyPoints,
        estimateMinutes,
        hasChildren,
      },
    ],
    ctx,
  );
  return advisories.filter(
    (a) => a.kind === 'shape' || a.kind === 'subsumption' || a.severity === 'likely-missing-edge',
  );
}
