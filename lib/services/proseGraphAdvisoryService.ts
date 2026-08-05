import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import {
  bodyReferenceSeverities,
  firstPostMergeCriterion,
  firstRepoStraddleCriterion,
  hasCriterionPathTokens,
  isOrderingCheckExempt,
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
   * The card's `targetRepo` pin — read ONLY by the REPO-STRADDLE check
   * (MOTIR-2177), which compares it against the repos its criteria name.
   *
   * `null` is a real answer with its own arm ("unpinnable"), not a missing
   * value, which is why it is required rather than optional: a caller that has
   * not decided what it knows would otherwise silently take the unpinned branch.
   * On the PROJECTED plan path a not-yet-materialized `add` genuinely has no
   * repo NAME — a proposal carries a `targetRepoRole`, resolved to a name only
   * at materialize — so `null` there is the truth, and the unpinnable arm is
   * exactly the right question to ask of it.
   */
  targetRepo: string | null;
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
    const rows = await workItemRepository.findByIdsInWorkspace([...unresolved], ctx.workspaceId);
    if (rows.length > 0) {
      const projects = await projectRepository.findByWorkspace(ctx.workspaceId);
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

  const advisories: WorkItemProseAdvisoryDto[] = [];
  for (const s of scanned) {
    // The SHAPE advisories first: they need no reference resolution at all (each
    // is a property of this body alone), so they are emitted even for a card
    // that names nothing. A card can carry BOTH — they are different defects.
    const ordering = orderingAdvisory(s.subject);
    if (ordering) advisories.push(ordering);
    const straddle = repoStraddleAdvisory(s.subject, repoCandidates);
    if (straddle) advisories.push(straddle);
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

/** SHAPE sorts before REFERENCE within one card. */
const familyRank = (a: WorkItemProseAdvisoryDto): number => (a.kind === 'shape' ? 0 : 1);

/**
 * The within-family tie-break key. A shape advisory has no far end, so it sorts
 * on its SEVERITY — stated rather than left to `Array.sort` stability, now that
 * one card can carry two of them (MOTIR-2177).
 */
const tieKey = (a: WorkItemProseAdvisoryDto): string =>
  a.kind === 'shape' ? a.severity : a.referenced;

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
  const found = firstRepoStraddleCriterion(subject.descriptionMd, subject.targetRepo, candidates);
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
  },
  ctx: ServiceContext,
): Promise<WorkItemProseAdvisoryDto[]> {
  const type = item.type ?? null;
  const executor = item.executor ?? null;
  const targetRepo = item.targetRepo ?? null;
  // Cheap short-circuit on the common shape: a body with no reference, no
  // ordering phrase and no path-like token in its criteria needs neither the
  // ancestor walk nor the edge read. ALL THREE scans are pure, and all three
  // must be clear — a body naming nothing can still carry an ordering violation
  // (MOTIR-2162's did) or a repo straddle (MOTIR-2057's did).
  const namesNothing = bodyReferenceSeverities(item.descriptionMd).size === 0;
  const wellOrdered =
    isOrderingCheckExempt(type, executor) || firstPostMergeCriterion(item.descriptionMd) === null;
  const namesNoPath = !hasCriterionPathTokens(item.descriptionMd);
  if (namesNothing && wellOrdered && namesNoPath) return [];

  const [ancestors, blockerLinks] = await Promise.all([
    workItemRepository.findAncestors(item.id, ctx.workspaceId),
    workItemLinkRepository.findByFromItem(item.id, 'is_blocked_by'),
  ]);
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
        targetRepo,
      },
    ],
    ctx,
  );
  return advisories.filter((a) => a.kind === 'shape' || a.severity === 'likely-missing-edge');
}
