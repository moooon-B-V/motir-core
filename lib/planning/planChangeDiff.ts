import { proposedParentNodeIds } from '@/lib/planning/planShape';
import { folderNodeId } from '@/lib/planning/projectCanvasModel';
import type { PlanReviewDto, PlanReviewItemDto } from '@/lib/dto/planReview';

// The PROPOSED-PLAN index behind the in-canvas diff (Subtask MOTIR-1730; design
// `design/ai-chat/plan-change-conversation.mock.html` panel 4). The conversation's
// run appends its proposals to a `Plan` as `PlanItem` rows, and the plan-review
// read (`getPlanReview`, MOTIR-847) returns them already resolved for a canvas —
// node ids, parents, live target fields, staleness. But the canvas renders one
// LEVEL at a time (drill-down, mistake #91). This module turns that flat item list
// into what the surface's gate needs: the counts the confirm bar and the rail
// read, and the folder badges.
//
// Pure (no React, no DOM, no fetching) so the placement rules are exhaustively
// unit-testable. It builds NO canvas level: the one level builder is
// `mergePlanLevel` (`components/planning/planLevel.tsx`, MOTIR-6299).
//
// ⚠️ It indexes the PLAN, not a `PlanDelta` (MOTIR-1746). Every plan-edit handler
// in motir-ai returns an EMPTY `planDelta` and writes its output as proposals
// instead (`addProposals` → `markPlanned`), so a delta-fed index was always empty
// and the review gate could never fire. Reading the plan also makes the design's
// fourth state real: a `remove` proposal is something the engine genuinely emits
// (`expandItem` / `replan`), where the delta contract had no op for it.

/**
 * Has this `add` BECOME a work item? `materialize` stamps `plan_item.workItemId`
 * on every add it creates, `getPlanReview` then keys the item's `nodeId` by that
 * work item and populates its `identifier` (MOTIR-3160) — so a non-null
 * identifier on an `add` is the review model saying "this is a card now".
 *
 * It matters here because the overlay OUTLIVES the decision (MOTIR-3162): a
 * materialized add is no longer a proposal beside the tree, it IS the committed
 * card, and drawing it as a synthetic `proposed:` node puts a second, keyless
 * copy of every accepted card on the canvas (bug MOTIR-3206). A DECLINED add
 * never materialized, keeps a null identifier, and correctly stays a ghost —
 * Part VI §3: *"a declined `add` keeps `new`, and must"*.
 */
function isMaterializedAdd(item: PlanReviewItemDto): boolean {
  return item.op === 'add' && item.identifier !== null;
}

/** One proposed `add`, placed in the drill-down forest. */
export interface ProposedAdd {
  /** The canvas node id: the synthetic `proposed:<planItemId>` while the add is
   *  still a proposal, and the WORK ITEM's own id once it has materialized — the
   *  same id the committed node on the level carries, so a decided add names
   *  the card it became rather than a keyless ghost beside it (MOTIR-3160's
   *  rule). */
  nodeId: string;
  /** The review item itself — already the shape `PlanItemNode` draws. */
  item: PlanReviewItemDto;
  /** The parent's canvas node id: another `add`'s synthetic id, an EXISTING work
   *  item's id, or null for a root proposal. */
  parentNodeId: string | null;
  /** Another proposed add is parented on this one → the node can be drilled. */
  hasChildren: boolean;
}

export interface PlanChangeDiffIndex {
  /** Every `modify` proposal, by its target work-item id. */
  changesById: Map<string, PlanReviewItemDto>;
  /** Every `remove` proposal, by its target work-item id. */
  removalsById: Map<string, PlanReviewItemDto>;
  adds: ProposedAdd[];
  /**
   * How many proposals will sit beneath each FOLDER, by folder id — every folder on
   * each proposal's `folderTrail`, so the count is DEEP (Part XVIII decision 3). A
   * proposal whose folder was deleted counts nowhere: there is no folder to mark.
   */
  folderChanges: Map<string, number>;
  /** The counts the confirm-to-persist bar + the rail both read. */
  counts: { added: number; changed: number; removed: number };
  /** No proposals at all → nothing to draw (an empty plan is a valid no-op). */
  isEmpty: boolean;
}

export const EMPTY_DIFF_INDEX: PlanChangeDiffIndex = {
  changesById: new Map(),
  removalsById: new Map(),
  adds: [],
  folderChanges: new Map(),
  counts: { added: 0, changed: 0, removed: 0 },
  isEmpty: true,
};

/**
 * Index a pending plan for the canvas. The review read has already resolved every
 * ref to a node id, so placement is one pass: an `add` parented on another `add`
 * carries that add's PlanItem id, which is re-prefixed here to the synthetic node
 * id the canvas draws; an `add` parented on a committed item carries that item's
 * real id, which IS its canvas node id and passes through untouched.
 */
export function indexPlanReview(review: PlanReviewDto | null | undefined): PlanChangeDiffIndex {
  if (!review || review.items.length === 0) return EMPTY_DIFF_INDEX;

  const changesById = new Map<string, PlanReviewItemDto>();
  const removalsById = new Map<string, PlanReviewItemDto>();
  const addItems: PlanReviewItemDto[] = [];
  for (const item of review.items) {
    if (item.op === 'add') addItems.push(item);
    else if (item.op === 'modify') changesById.set(item.nodeId, item);
    else removalsById.set(item.nodeId, item);
  }

  // Which node ids belong to a still-PROPOSED item, so a parent ref pointing at
  // one is prefixed and a parent ref pointing at a committed item is left alone.
  //
  // A MATERIALIZED add is deliberately not in this set: its node id is already a
  // real work-item id, so it needs no prefix and a child of it must point at that
  // same id — otherwise a decided add's children would be parented on a node that
  // is not on the canvas (the same failure `getPlanReview`'s ref resolution fixes
  // server-side).
  const proposedNodeIds = new Set(
    addItems.filter((item) => !isMaterializedAdd(item)).map((item) => item.nodeId),
  );
  // The `proposed:` prefix means a still-proposed add can never collide with a real
  // work-item id. A `modify` / `remove` keeps the TARGET's own id — it is the same
  // node as the existing item, not a ghost copy.
  const canvasNodeId = (nodeId: string) =>
    proposedNodeIds.has(nodeId) ? `proposed:${nodeId}` : nodeId;

  // A FOLDER-PLACED proposal is a root in the review model (`parentNodeId: null`)
  // and sits on its folder's LEVEL on this canvas (Part XVIII decision 2) — the
  // focus id a folder level already has (`folder:<id>`, MOTIR-5741), so its
  // `parentNodeId` names that level with no second key.
  const adds: ProposedAdd[] = addItems.map((item) => ({
    nodeId: canvasNodeId(item.nodeId),
    item,
    parentNodeId:
      item.parentNodeId === null ? folderLevelOf(item) : canvasNodeId(item.parentNodeId),
    hasChildren: false,
  }));

  const withChildren = proposedParentNodeIds(adds);
  for (const add of adds) add.hasChildren = withChildren.has(add.nodeId);

  const folderChanges = folderChangeCounts(review.items);

  return {
    changesById,
    removalsById,
    adds,
    folderChanges,
    counts: { added: adds.length, changed: changesById.size, removed: removalsById.size },
    isEmpty: false,
  };
}

/**
 * How many of the plan's proposals sit behind each FOLDER, counted DEEP (design
 * Part XVIII §18.3): every proposal of any op whose `folderTrail` holds the folder
 * — filed in it, in a sub-folder, or under a work item filed in it. Keyed by the
 * folder's id. A stale folder counts nowhere (decision 6). One count for both
 * planning canvases, so the overlay and the review badge the same number.
 */
export function folderChangeCounts(items: readonly PlanReviewItemDto[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.folderMissing) continue;
    // `?? []`: a payload from a server older than MOTIR-5798 carries no trail, and
    // must read as "no folder" rather than throw while the page renders.
    for (const crumb of item.folderTrail ?? []) {
      counts.set(crumb.id, (counts.get(crumb.id) ?? 0) + 1);
    }
  }
  return counts;
}

/** The folder LEVEL a root proposal sits on: its folder's canvas id when it is
 *  filed into one that still exists, else the project root. */
function folderLevelOf(item: PlanReviewItemDto): string | null {
  return item.folderId !== null && !item.folderMissing ? folderNodeId(item.folderId) : null;
}
