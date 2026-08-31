import type { PlanReviewDto, PlanReviewItemDto } from '@/lib/dto/planReview';

// Builders for the plan-REVIEW model the plan-change conversation now reviews
// (MOTIR-1746). The rail, its canvas and the confirm bar all read the Plan the
// run appended its proposals to, so every test around that surface needs the same
// `PlanReviewDto` shape — built here once rather than re-declared per file.
//
// The DTO's own assembly (refs → node ids, live target fields, staleness) is
// covered by the real-Postgres `planReviewService` suite; these builders only
// stand in for its OUTPUT.

export function planReviewItem(over: Partial<PlanReviewItemDto> = {}): PlanReviewItemDto {
  return {
    planItemId: 'pi_1',
    op: 'add',
    nodeId: 'pi_1',
    parentNodeId: null,
    // The COMMITTED parent (MOTIR-3083) — null by default, so an existing case
    // keeps describing a top-level proposal and a parented one opts in.
    parentIdentifier: null,
    parentTitle: null,
    parentKind: null,
    // The committed ANCESTOR path down to that parent (bug MOTIR-3152) — empty by
    // default, matching the null parent above.
    parentTrail: [],
    blockedByNodeIds: [],
    identifier: null,
    title: 'A proposed item',
    kind: 'task',
    priority: null,
    type: null,
    descriptionMd: null,
    explanationMd: null,
    explanationSource: null,
    storyPoints: null,
    estimateMinutes: null,
    targetRepo: null,
    targetRepoRole: null,
    executor: null,
    planningProvenance: null,
    status: null,
    statusLabel: null,
    statusCategory: null,
    hasChildren: false,
    changes: [],
    stale: false,
    staleReasons: [],
    // MOVED in the plan's latest revision (MOTIR-3601) — false by default, so
    // every existing case keeps describing a plan nobody has revised.
    revised: false,
    targetMissing: false,
    ...over,
  };
}

export function planReview(
  items: PlanReviewItemDto[],
  over: Partial<PlanReviewDto> = {},
): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'proj_1',
    // `planned` is the only status that is a PENDING review — the gate turns on it.
    status: 'planned',
    title: null,
    summary: null,
    itemCount: items.length,
    createdAt: '2026-07-27T09:00:00.000Z',
    plannedAt: '2026-07-27T09:01:00.000Z',
    decidedAt: null,
    decidedByName: null,
    // Not recorded — the default a `planned` plan has, and what every `declined`
    // row written before MOTIR-3189's column reads. A case that wants a
    // DISCARDED or ABANDONED outcome overrides it.
    decisionReason: null,
    // The three-party attribution (MOTIR-2991). The default is the UNATTRIBUTED
    // state, so every pre-existing case keeps asserting a header without one and
    // each attribution state opts in explicitly.
    origin: 'user',
    createdByName: null,
    authorSource: null,
    authorHarness: null,
    authorModel: null,
    history: [],
    // No revision running (MOTIR-3601). Null rather than a falsy object, so a
    // case that wants an IN-FLIGHT rail opts in and no existing one silently
    // renders a held Approve.
    revision: null,
    items,
    stale: false,
    staleCount: 0,
    // A small level, so the derived default is the CANVAS unless a case says
    // otherwise (MOTIR-4024).
    arrivalLevelSize: 1,
    arrivalLevelTotal: 1,
    ...over,
  };
}
