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
    hasChildren: false,
    changes: [],
    stale: false,
    staleReasons: [],
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
    // The three-party attribution (MOTIR-2991). The default is the UNATTRIBUTED
    // state, so every pre-existing case keeps asserting a header without one and
    // each attribution state opts in explicitly.
    origin: 'user',
    createdByName: null,
    authorSource: null,
    authorHarness: null,
    authorModel: null,
    history: [],
    items,
    stale: false,
    staleCount: 0,
    ...over,
  };
}
