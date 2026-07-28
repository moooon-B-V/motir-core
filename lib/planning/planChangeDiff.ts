import type { PlanReviewDto, PlanReviewItemDto } from '@/lib/dto/planReview';

// The PROPOSED-PLAN index behind the in-canvas diff (Subtask MOTIR-1730; design
// `design/ai-chat/plan-change-conversation.mock.html` panel 4). The conversation's
// run appends its proposals to a `Plan` as `PlanItem` rows, and the plan-review
// read (`getPlanReview`, MOTIR-847) returns them already resolved for a canvas —
// node ids, parents, live target fields, staleness. But the canvas renders one
// LEVEL at a time (drill-down, mistake #91). This module turns that flat item list
// into what a level needs: "is THIS item changed / removed / locked?" and "which
// proposed items are children of THIS focus?".
//
// Pure (no React, no DOM, no fetching) so the placement rules are exhaustively
// unit-testable; `planChangeLevel.tsx` renders what it returns.
//
// ⚠️ It indexes the PLAN, not a `PlanDelta` (MOTIR-1746). Every plan-edit handler
// in motir-ai returns an EMPTY `planDelta` and writes its output as proposals
// instead (`addProposals` → `markPlanned`), so a delta-fed index was always empty
// and the review gate could never fire. Reading the plan also makes the design's
// fourth state real: a `remove` proposal is something the engine genuinely emits
// (`expandItem` / `replan`), where the delta contract had no op for it.

/** The visual state a canvas node takes under a pending proposal. */
export type PlanChangeDiffState = 'add' | 'change' | 'remove' | 'locked';

/** The canvas node id prefix for a proposed (not-yet-persisted) item. Prefixed so
 *  it can never collide with a real work-item id, and so the canvas's drill /
 *  quick-view paths can tell a proposal from a committed item. A `modify` /
 *  `remove` keeps the TARGET's own id — it is the same node as the existing item,
 *  not a ghost copy. */
export const PROPOSED_NODE_PREFIX = 'proposed:';

export function isProposedNodeId(id: string): boolean {
  return id.startsWith(PROPOSED_NODE_PREFIX);
}

/**
 * Statuses whose items an approve REFUSES to modify. This mirrors the server
 * gate exactly: `plansService.approvePlan`'s persist gate (7.12.5 · MOTIR-911)
 * rejects any target whose status sits in a `done`-CATEGORY workflow status,
 * which in the default workflow is `done` + `cancelled`. Locking them on the
 * canvas is the same rule made visible BEFORE the user approves (design panel 4 —
 * "the engine proposes around finished work, never over it").
 */
const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

/** One proposed `add`, placed in the drill-down forest. */
export interface ProposedAdd {
  /** The synthetic canvas node id (`proposed:<planItemId>`). */
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
  /** The counts the confirm-to-persist bar + the rail both read. */
  counts: { added: number; changed: number; removed: number };
  /** No proposals at all → nothing to draw (an empty plan is a valid no-op). */
  isEmpty: boolean;
}

export const EMPTY_DIFF_INDEX: PlanChangeDiffIndex = {
  changesById: new Map(),
  removalsById: new Map(),
  adds: [],
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

  // Which node ids belong to a PROPOSED item, so a parent ref pointing at one is
  // prefixed and a parent ref pointing at a committed item is left alone.
  const addNodeIds = new Set(addItems.map((item) => item.nodeId));
  const canvasNodeId = (nodeId: string) =>
    addNodeIds.has(nodeId) ? `${PROPOSED_NODE_PREFIX}${nodeId}` : nodeId;

  const adds: ProposedAdd[] = addItems.map((item) => ({
    nodeId: `${PROPOSED_NODE_PREFIX}${item.nodeId}`,
    item,
    parentNodeId: item.parentNodeId === null ? null : canvasNodeId(item.parentNodeId),
    hasChildren: false,
  }));

  const withChildren = new Set(
    adds.map((a) => a.parentNodeId).filter((id): id is string => id !== null),
  );
  for (const add of adds) add.hasChildren = withChildren.has(add.nodeId);

  return {
    changesById,
    removalsById,
    adds,
    counts: { added: adds.length, changed: changesById.size, removed: removalsById.size },
    isEmpty: false,
  };
}

/** The diff state an EXISTING level item takes, or null when the proposal doesn't
 *  touch it and it is freely editable. Terminal wins over a proposed change or
 *  removal: a finished item the engine tried to touch is still locked (and the
 *  approve is rejected server-side), so the lock is what the user must see. */
export function diffStateForItem(
  index: PlanChangeDiffIndex,
  item: { id: string; status: string },
): PlanChangeDiffState | null {
  if (TERMINAL_STATUSES.has(item.status)) return 'locked';
  if (index.removalsById.has(item.id)) return 'remove';
  return index.changesById.has(item.id) ? 'change' : null;
}

/** The proposal (`modify` or `remove`) that put an existing item in that state,
 *  so the node can name WHAT changed. Null for `add` / `locked` / untouched. */
export function proposalForItem(
  index: PlanChangeDiffIndex,
  itemId: string,
): PlanReviewItemDto | undefined {
  return index.removalsById.get(itemId) ?? index.changesById.get(itemId);
}

/** The proposed items that belong on the level currently in focus. `focusNodeId`
 *  is the canvas focus (null at the top level) — for a committed item that is its
 *  work-item id, which is exactly what an `add` parented on it carries. */
export function proposedAddsForLevel(
  index: PlanChangeDiffIndex,
  focusNodeId: string | null,
): ProposedAdd[] {
  return index.adds.filter((a) => a.parentNodeId === focusNodeId);
}

/** The wire field names `planReviewService` emits → the diff-chrome's copy keys.
 *  It doubles as the WHITELIST: a field with no key here is dropped rather than
 *  rendered, so adding a diffable field server-side can never crash the canvas on
 *  a missing translation — it just doesn't name it until the copy lands. */
const FIELD_KEY: Record<string, string> = {
  title: 'title',
  priority: 'priority',
  type: 'type',
  description: 'description',
  links: 'links',
  estimateMinutes: 'estimate',
  storyPoints: 'points',
};

/** The fields a `modify` proposal changes, as those copy keys — the compact "what
 *  changed" line on a changed node. */
export function changedFields(item: PlanReviewItemDto): string[] {
  return item.changes
    .map((change) => FIELD_KEY[change.field])
    .filter((key): key is string => key !== undefined);
}
