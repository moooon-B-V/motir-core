import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// THE SHAPE OF A PLAN — how its proposals are spread across containers
// (MOTIR-3260, `design/ai-planning/design-notes.md` Part IX).
//
// A plan is not a tree; it is a SCATTER of proposals across somebody else's tree.
// Two surfaces need to reason about that scatter and neither should re-derive it:
// the canvas needs the level the plan most FILLS (so it opens there), and the
// plan detail needs to know whether the plan STRADDLES containers (so it can
// choose which body to open in — MOTIR-3262).
//
// PURE by construction: no React, no fetch, no clock. It takes `PlanReviewItemDto[]`
// — the model the island already holds — and answers questions about it, so both
// consumers can be unit-tested against plain fixtures.

/** One container the plan proposes into, and how much of the plan sits there. */
export interface PlanContainer {
  /**
   * The container's canvas node id, or `null` for the TOP LEVEL — a proposal with
   * no parent at all.
   *
   * ⚠️ It may name a COMMITTED work item OR another PROPOSAL. That is the whole
   * point of counting `parentNodeId` rather than `parentIdentifier`: an intra-plan
   * (`planItem:`) parent has a node id and deliberately has no identifier, because
   * the canvas draws it and the breadcrumb does not (`lib/dto/planReview.ts`).
   */
  parentNodeId: string | null;
  /** How many of the plan's proposals sit directly under it. */
  count: number;
  /** How deep it sits — the length of the committed ancestor chain plus one crumb
   *  per PROPOSED container above it. The tie-break reads this. */
  depth: number;
}

/** Every container the plan touches, most-filled first, deeper first on a tie. */
export function planContainers(items: PlanReviewItemDto[]): PlanContainer[] {
  const byNode = new Map<string | null, number>();
  for (const item of items) {
    const key = item.parentNodeId ?? null;
    byNode.set(key, (byNode.get(key) ?? 0) + 1);
  }

  const containers = [...byNode].map(([parentNodeId, count]) => ({
    parentNodeId,
    count,
    depth: containerDepth(items, parentNodeId),
  }));

  // Most-filled first; on a tie the DEEPER level (Part IX §1.2). The shipped code
  // kept whichever level the `Map` yielded first, which is an accident of
  // insertion order rather than a decision — a reviewer wants to land where the
  // work is, and the shallower level is one Back away while the deeper one is a
  // drill they must first discover. The final `id` comparison keeps the whole
  // ordering deterministic when count AND depth tie.
  containers.sort(
    (a, b) =>
      b.count - a.count ||
      b.depth - a.depth ||
      String(a.parentNodeId).localeCompare(String(b.parentNodeId)),
  );
  return containers;
}

/**
 * How deep a container sits: the committed ancestor chain of the item that names
 * it, plus one for each PROPOSED container above it.
 *
 * Walks the proposal chain rather than assuming one hop — a plan may propose an
 * epic, a story under it, and subtasks under that, and the depth of the story's
 * level is then two proposals above a committed chain of length zero.
 */
function containerDepth(items: PlanReviewItemDto[], parentNodeId: string | null): number {
  if (parentNodeId === null) return 0;
  const byNodeId = new Map(items.map((item) => [item.nodeId, item]));

  let depth = 0;
  let cursor: string | null = parentNodeId;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    const proposal: PlanReviewItemDto | undefined = byNodeId.get(cursor);
    if (!proposal) {
      // A COMMITTED container. Its own committed ancestors are carried on any
      // item that names it, so the chain ends here with that trail's length.
      const namer = items.find((item) => item.parentNodeId === cursor);
      return depth + (namer ? Math.max(namer.parentTrail.length - 1, 0) : 0);
    }
    // A PROPOSED container — keep walking up the proposal chain. When it runs
    // out, the committed trail it carries finishes the count.
    cursor = proposal.parentNodeId;
    if (cursor === null) return depth + Math.max(proposal.parentTrail.length, 0);
  }
  return depth;
}

/**
 * HOW MANY DISTINCT CONTAINERS the plan touches.
 *
 * The number MOTIR-3262's derived default reads: **more than one ⇒ the plan
 * straddles**, and no single canvas level can show it. A plan of pure roots has
 * exactly ONE container (the top level), so it does not straddle — Part IX §3
 * settles that, and it is why `null` is a key here rather than being skipped.
 */
export function planContainerCount(items: PlanReviewItemDto[]): number {
  return planContainers(items).length;
}

/**
 * The container the plan most FILLS — where the canvas should open — or `null`
 * for a plan with no proposals, or one that lives entirely at the top level.
 */
export function fullestContainer(items: PlanReviewItemDto[]): PlanContainer | null {
  const [first] = planContainers(items);
  if (!first || first.parentNodeId === null) return null;
  return first;
}
