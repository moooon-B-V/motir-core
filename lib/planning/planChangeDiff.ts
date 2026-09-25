import { proposedParentNodeIds } from '@/lib/planning/planShape';
import { folderNodeId } from '@/lib/planning/projectCanvasModel';
import type { PlanPlacementSideDto, PlanReviewDto, PlanReviewItemDto } from '@/lib/dto/planReview';

// The PROPOSED-PLAN index behind the in-canvas diff (Subtask MOTIR-1730; design
// `design/ai-chat/plan-change-conversation.mock.html` panel 4). The conversation's
// run appends its proposals to a `Plan` as `PlanItem` rows, and the plan-review
// read (`getPlanReview`, MOTIR-847) returns them already resolved for a canvas —
// node ids, parents, live target fields, staleness. But the canvas renders one
// LEVEL at a time (drill-down, mistake #91). This module turns that flat item list
// into what the surface's gate needs: the counts the confirm bar and the rail
// read, the folder badges, and "which proposed items are children of THIS focus?".
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

/**
 * A `modify` that MOVES its target into or out of a FOLDER (Bug MOTIR-5782; design
 * Part XVIII decision 4) — drawn ONCE, at its destination level, and taken off its
 * source level. Levels are canvas focus ids: `folder:<id>` for a folder level, a
 * work-item id, or null for the project root.
 */
export interface FolderRelocation {
  item: PlanReviewItemDto;
  fromLevel: string | null;
  toLevel: string | null;
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
  /** The folder moves (decision 4). A move between two work items is not here: the
   *  overlay draws those where the committed read carries them, as it always has. */
  relocations: FolderRelocation[];
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
  relocations: [],
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
  const canvasNodeId = (nodeId: string) =>
    proposedNodeIds.has(nodeId) ? `${PROPOSED_NODE_PREFIX}${nodeId}` : nodeId;

  // A FOLDER-PLACED proposal is a root in the review model (`parentNodeId: null`)
  // and sits on its folder's LEVEL on this canvas (Part XVIII decision 2) — the
  // focus id a folder level already has (`folder:<id>`, MOTIR-5741), so
  // `proposedAddsForLevel` places it with no second key.
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

  const relocations: FolderRelocation[] = [];
  for (const item of review.items) {
    if (item.op !== 'modify') continue;
    const placement = item.changes.find((c) => c.field === 'parent')?.placement;
    if (!placement) continue;
    if (placement.from.kind !== 'folder' && placement.to.kind !== 'folder') continue;
    relocations.push({
      item,
      fromLevel: levelOfSide(placement.from),
      toLevel: levelOfSide(placement.to),
    });
  }

  return {
    changesById,
    removalsById,
    adds,
    folderChanges,
    relocations,
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

/** One side of a placement, as the canvas focus id of the level it names. A
 *  deleted folder has no level, so its side reads as the root (decision 6). */
function levelOfSide(side: PlanPlacementSideDto): string | null {
  if (side.kind === 'root') return null;
  if (side.kind === 'workItem') return side.id;
  return side.folderMissing ? null : folderNodeId(side.folderId);
}

/** The proposal (`modify` or `remove`) that touches an existing item, so a
 *  caller can name WHAT changed. Undefined for an item the plan does not touch.
 *  (A `locked` treatment is no longer decided here: it is `PlanItemNode`'s
 *  `isLockedProposal`, drawn only on a modify / remove of a finished target —
 *  MOTIR-6296.) */
export function proposalForItem(
  index: PlanChangeDiffIndex,
  itemId: string,
): PlanReviewItemDto | undefined {
  return index.removalsById.get(itemId) ?? index.changesById.get(itemId);
}

/**
 * Does the PENDING PROPOSAL touch this committed row? The third conjunct the
 * plan-change canvases add to the grouping predicate
 * (`design/ai-planning/design-notes.md` Part XVI, DECISION 2): the road is the
 * epics AND what the change is about, so a row the proposal touches stays on the
 * level the reviewer is standing on instead of moving behind the group's door.
 *
 * ⚠️ THIS IS MEMBERSHIP IN THE PROPOSAL, never a row's own status — the trap
 * Part XVI §16.8 names. Most parentless defects on a mature tree are `done`, so
 * keying on terminal status would drag nearly the whole group back onto the road
 * the moment any plan is pending.
 *
 * A MATERIALIZED `add` qualifies through `adds`: its `nodeId` IS the committed
 * work item's id ({@link isMaterializedAdd}), which is exactly the row a decided
 * add lands ON — and grouping that row away is what re-opens MOTIR-3206 (the
 * accepted card drawn a second time as a keyless ghost). A still-PENDING add
 * cannot collide here: its `nodeId` carries the `proposed:` prefix, which no
 * work-item id has.
 *
 * A pending add's TARGET qualifies through `parentNodeId`, and it is the case the
 * `nodeId` clauses above all miss: the commonest contextual ask ("break this
 * story into subtasks") touches the anchor through nothing but the parent ref its
 * adds carry — no `modify`, no `remove`, and a `proposed:`-prefixed `nodeId` that
 * matches no committed row. Group the anchor away and the proposal becomes
 * UNREACHABLE: it is drawn one level down, under a row that is now behind the
 * group's door, so the reviewer cannot drill to the thing they are being asked to
 * confirm. `parentNodeId` has already been through `canvasNodeId`, so a committed
 * parent compares as its real work-item id and a proposed one carries the prefix
 * and stays inert here — the same asymmetry the `nodeId` clause relies on.
 */
export function touchedByProposal(index: PlanChangeDiffIndex, workItemId: string): boolean {
  if (index.isEmpty) return false;
  if (index.changesById.has(workItemId) || index.removalsById.has(workItemId)) return true;
  return index.adds.some((add) => add.nodeId === workItemId || add.parentNodeId === workItemId);
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
 *  a missing translation — it just doesn't name it until the copy lands.
 *
 *  EXPORTED so `tests/components/plan-change-field-labels.test.tsx` can hold it
 *  against `PLAN_ITEM_CHANGE_FIELDS` (MOTIR-3151). The drop is the runtime SAFETY
 *  NET and stays; what the test adds is that a field of today's vocabulary must
 *  not be silently omitted from this node's summary — the failure this map is
 *  gentle about is invisible rather than loud, which is how it survives. */
export const FIELD_KEY: Record<string, string> = {
  title: 'title',
  priority: 'priority',
  type: 'type',
  // The executor a re-type SEEDS (MOTIR-6259) — derived by the approve, like `status`.
  executor: 'executor',
  description: 'description',
  explanation: 'explanation',
  links: 'links',
  estimateMinutes: 'estimate',
  storyPoints: 'points',
  // A leaf's DIFFICULTY (MOTIR-6137, design Part XX §20.8) — the change frame's
  // chip reads `difficulty`.
  difficulty: 'difficulty',
  parent: 'parent',
  // Where the card SHIPS (MOTIR-3868) — the twin of `parent` above. This map is
  // the QUIETEST of the three: it DROPS what it does not recognise, so a field
  // missing here simply vanishes from the changed node's summary.
  targetRepo: 'repo',
  targetRepoRole: 'repoRole',
  // The re-scope reset (MOTIR-5359) — derived by the approve, not patched.
  status: 'status',
};

/** The fields a `modify` proposal changes, as those copy keys — the compact "what
 *  changed" line on a changed node. */
export function changedFields(item: PlanReviewItemDto): string[] {
  return item.changes
    .map((change) => FIELD_KEY[change.field])
    .filter((key): key is string => key !== undefined);
}
