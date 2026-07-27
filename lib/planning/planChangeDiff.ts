import type { PlanDelta, PlanDeltaCreateOp, PlanDeltaUpdateOp } from '@/lib/ai/planDelta';

// The PROPOSED-DELTA index behind the in-canvas diff (Subtask MOTIR-1730; design
// `design/ai-chat/plan-change-conversation.mock.html` panel 4). The conversation's
// job returns a `PlanDelta` — a flat op list keyed by work-item KEY (`MOTIR-12`)
// and by intra-delta `ref` — but the canvas renders one LEVEL at a time
// (drill-down, mistake #91). This module turns the flat list into what a level
// needs: "is THIS item changed / locked?" and "which proposed items are children
// of THIS focus?".
//
// Pure (no React, no DOM, no fetching) so the placement rules are exhaustively
// unit-testable; `planChangeLevel.tsx` renders what it returns.
//
// ⚠️ The shipped delta contract (`lib/ai/planDelta.ts`) carries `create` and
// `update` ONLY — `link` / `move` "arrive with the generation stories", and there
// is no delete/remove op at all. So the four design states map to three the
// shipped engine can actually produce: ADD (a create), CHANGE (an update), and
// LOCKED (an existing item in a terminal status). The design's REMOVE state has
// no op to drive it and is deliberately not faked here; when a remove op lands in
// the contract it becomes a fourth `PlanChangeDiffState`.

/** The visual state a canvas node takes under a pending proposal. */
export type PlanChangeDiffState = 'add' | 'change' | 'locked';

/** The canvas node id prefix for a proposed (not-yet-persisted) item. Prefixed so
 *  it can never collide with a real work-item id, and so the canvas's drill /
 *  quick-view paths can tell a proposal from a committed item. */
export const PROPOSED_NODE_PREFIX = 'proposed:';

export function isProposedNodeId(id: string): boolean {
  return id.startsWith(PROPOSED_NODE_PREFIX);
}

/**
 * Statuses whose items an approve REFUSES to modify. This mirrors the server
 * gate exactly: `aiPlanEditsService.approve` throws `PlanDeltaImmutabilityError`
 * for any target whose status sits in a `done`-CATEGORY workflow status, which in
 * the default workflow is `done` + `cancelled`. Locking them on the canvas is the
 * same rule made visible BEFORE the user approves (design panel 4 — "the engine
 * proposes around finished work, never over it").
 */
const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

/** One proposed `create`, placed in the drill-down forest. */
export interface ProposedAdd {
  /** The synthetic canvas node id (`proposed:<i>`). */
  nodeId: string;
  op: PlanDeltaCreateOp;
  /** Parent by an EARLIER create's `ref` → that create's synthetic node id. */
  parentNodeId: string | null;
  /** Parent by an EXISTING work item's key (`MOTIR-12`), or null for a root. */
  parentKey: string | null;
  /** Another proposed create is parented on this one → the node can be drilled. */
  hasChildren: boolean;
}

export interface PlanChangeDiffIndex {
  /** Every `update` op, by its target work-item key. */
  updatesByKey: Map<string, PlanDeltaUpdateOp>;
  adds: ProposedAdd[];
  /** The counts the confirm-to-persist bar + the rail both read. */
  counts: { added: number; changed: number };
  /** No operations at all → nothing to draw (an empty delta is a valid no-op). */
  isEmpty: boolean;
}

export const EMPTY_DIFF_INDEX: PlanChangeDiffIndex = {
  updatesByKey: new Map(),
  adds: [],
  counts: { added: 0, changed: 0 },
  isEmpty: true,
};

/**
 * Index a delta for the canvas. Placement resolution, in one pass:
 *  - a `create` with `parentRef` hangs off the synthetic node of the create that
 *    declared that `ref` (an unknown ref degrades to a root, never a dropped node);
 *  - a `create` with `parentKey` hangs off that EXISTING item's level;
 *  - a `create` with neither is a root proposal (drawn at the top level).
 */
export function indexPlanDelta(delta: PlanDelta | null | undefined): PlanChangeDiffIndex {
  if (!delta || delta.operations.length === 0) return EMPTY_DIFF_INDEX;

  const updatesByKey = new Map<string, PlanDeltaUpdateOp>();
  const creates: PlanDeltaCreateOp[] = [];
  for (const op of delta.operations) {
    if (op.op === 'update') updatesByKey.set(op.targetKey, op);
    else creates.push(op);
  }

  // ref → synthetic node id, so a `parentRef` resolves to a node the canvas has.
  const nodeIdByRef = new Map<string, string>();
  creates.forEach((op, i) => {
    if (op.ref) nodeIdByRef.set(op.ref, `${PROPOSED_NODE_PREFIX}${i}`);
  });

  const adds: ProposedAdd[] = creates.map((op, i) => {
    const parentNodeId = op.parentRef ? (nodeIdByRef.get(op.parentRef) ?? null) : null;
    return {
      nodeId: `${PROPOSED_NODE_PREFIX}${i}`,
      op,
      parentNodeId,
      // A `parentRef` that RESOLVED wins; an unresolvable one falls back to the
      // item key when the op carried both-ish shapes (the parser allows only one,
      // so in practice exactly one of these is set).
      parentKey: parentNodeId === null ? (op.parentKey ?? null) : null,
      hasChildren: false,
    };
  });

  const withChildren = new Set(adds.map((a) => a.parentNodeId).filter((id): id is string => !!id));
  for (const add of adds) add.hasChildren = withChildren.has(add.nodeId);

  return {
    updatesByKey,
    adds,
    counts: { added: adds.length, changed: updatesByKey.size },
    isEmpty: false,
  };
}

/** The diff state an EXISTING level item takes, or null when the proposal doesn't
 *  touch it and it is freely editable. Terminal wins over a proposed change: a
 *  finished item the engine tried to modify is still locked (and the approve is
 *  rejected server-side), so the lock is what the user must see. */
export function diffStateForItem(
  index: PlanChangeDiffIndex,
  item: { identifier: string; status: string },
): PlanChangeDiffState | null {
  if (TERMINAL_STATUSES.has(item.status)) return 'locked';
  return index.updatesByKey.has(item.identifier) ? 'change' : null;
}

/** The proposed items that belong on the level currently in focus. `focusNodeId`
 *  is the canvas focus (null at the top level); `focusKey` is that focus's work-item
 *  key when it is a committed item (null at the top level, or when the key isn't
 *  known yet). */
export function proposedAddsForLevel(
  index: PlanChangeDiffIndex,
  focus: { focusNodeId: string | null; focusKey: string | null },
): ProposedAdd[] {
  if (focus.focusNodeId !== null && isProposedNodeId(focus.focusNodeId)) {
    return index.adds.filter((a) => a.parentNodeId === focus.focusNodeId);
  }
  if (focus.focusNodeId === null) {
    return index.adds.filter((a) => a.parentNodeId === null && a.parentKey === null);
  }
  if (focus.focusKey === null) return [];
  return index.adds.filter((a) => a.parentNodeId === null && a.parentKey === focus.focusKey);
}

/** The fields an `update` op changes, as plain field names — the compact
 *  "what changed" line on a changed node and in the rail's summary. */
export function changedFields(op: PlanDeltaUpdateOp): string[] {
  const fields: string[] = [];
  if (op.fields.title !== undefined) fields.push('title');
  if (op.fields.priority !== undefined) fields.push('priority');
  if (op.fields.type !== undefined) fields.push('type');
  if (op.fields.estimateMinutes !== undefined) fields.push('estimate');
  if (op.fields.descriptionMd !== undefined) fields.push('description');
  return fields;
}
