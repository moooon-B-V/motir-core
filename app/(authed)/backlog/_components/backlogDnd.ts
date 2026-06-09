import type { WorkItemSummaryDto } from '@/lib/dto/workItems';

// Pure backlog-drag resolution (Story 4.2 · Subtask 4.2.4) — the side-effect-free
// core the dnd-kit wiring in BacklogDndProvider drives, kept React-free so the
// "which write fires + how the lists relocate" logic is unit-testable in
// isolation (mirrors `boards/_components/boardMove.ts`). The provider tracks the
// drop's `over` target, resolves a `BacklogMovePlan` here ONCE on drop, applies
// it optimistically, fires the matching Story-4.1.4 single-issue write, and snaps
// back on rejection. Nothing here touches the network or React.
//
// The backlog is a stack of REGIONS — the bottom backlog (`sprint_id IS NULL`)
// and zero-or-more sprint containers — each holding its own bounded, rank-ordered
// `WorkItemSummaryDto[]` (finding #57). One global `backlogRank`, so a row drags
// between regions. Three moves map to the three 4.1.4 primitives:
//   * reorder within a region   → `rankIssue`     (single-row `keyBetween` write)
//   * backlog→sprint / sprint→sprint → `assignToSprint` (placement honoured)
//   * sprint→backlog            → `moveToBacklog`  (keeps rank; reappears in order)

export type RegionKind = 'backlog' | 'sprint';

/** The dnd-kit droppable id for the bottom backlog region (distinct from row ids = item ids). */
export const BACKLOG_REGION_ID = 'region:backlog';

/** The dnd-kit droppable id for a sprint region. */
export function sprintRegionId(sprintId: string): string {
  return `region:sprint:${sprintId}`;
}

/** Identity of a drop region — its droppable id, kind, and (for a sprint) the sprint id. */
export interface RegionRef {
  id: string;
  kind: RegionKind;
  sprintId?: string;
}

/** A drop resolved from a drag — the optimistic relocation + the write it triggers. */
export interface BacklogMovePlan {
  /** `none` = dropped back in its own slot (no write, no relocation). */
  kind: 'reorder' | 'assign' | 'to-backlog' | 'none';
  activeId: string;
  source: RegionRef;
  target: RegionRef;
  /** The neighbour the moved row ends up directly ABOVE (the rank `beforeId`). */
  beforeId?: string;
  /** The neighbour directly BELOW (the rank `afterId`). */
  afterId?: string;
  /** Where the row lands in the target's items AFTER removing the active row. */
  insertAt: number;
}

/** The single-issue write a non-`none` plan fires (the 4.1.4 routes). */
export interface BacklogWrite {
  url: string;
  body: Record<string, unknown>;
}

interface HasId {
  id: string;
}

/**
 * Resolve the insertion slot in `targetItems` for `activeId`, given the hovered
 * `overId` (a row id, or the region's own droppable id when `overIsRegion`). The
 * active row is removed from consideration first, so a same-region drop indexes
 * against the list WITHOUT the row being moved. Drop-on-region appends at the
 * end; drop-on-row inserts BEFORE that row (the predictable "lands where you
 * point" rule). `beforeId`/`afterId` bracket the slot for the rank write.
 */
export function resolveInsertion(
  targetItems: WorkItemSummaryDto[],
  activeId: string,
  overId: string,
  overIsRegion: boolean,
): { beforeId?: string; afterId?: string; insertAt: number } {
  const without = targetItems.filter((i) => i.id !== activeId);
  let insertAt: number;
  if (overIsRegion || overId === activeId) {
    insertAt = without.length;
  } else {
    const oi = without.findIndex((i) => i.id === overId);
    insertAt = oi === -1 ? without.length : oi;
  }
  return { beforeId: without[insertAt - 1]?.id, afterId: without[insertAt]?.id, insertAt };
}

/**
 * Resolve a drop into a structured `BacklogMovePlan`. `sourceIndex` is the active
 * row's index in its source region (full array) — a same-region drop that lands
 * in that same slot is a `none` no-op (no write). Cross-region drops are `assign`
 * (into a sprint) or `to-backlog`.
 */
export function planBacklogMove(args: {
  source: RegionRef;
  target: RegionRef;
  activeId: string;
  targetItems: WorkItemSummaryDto[];
  sourceIndex: number;
  overId: string;
  overIsRegion: boolean;
}): BacklogMovePlan {
  const { source, target, activeId, targetItems, sourceIndex, overId, overIsRegion } = args;
  const { beforeId, afterId, insertAt } = resolveInsertion(
    targetItems,
    activeId,
    overId,
    overIsRegion,
  );

  if (source.id === target.id) {
    // A same-region drop that resolves to the row's own slot moves nothing.
    if (insertAt === sourceIndex) {
      return { kind: 'none', activeId, source, target, insertAt };
    }
    return { kind: 'reorder', activeId, source, target, beforeId, afterId, insertAt };
  }

  const kind: BacklogMovePlan['kind'] = target.kind === 'backlog' ? 'to-backlog' : 'assign';
  return { kind, activeId, source, target, beforeId, afterId, insertAt };
}

/**
 * The single-issue write a plan fires (Story 4.1.4 routes). `reorder` reorders in
 * the current scope; `assign` assigns to the target sprint with the drop
 * placement; `to-backlog` nulls the sprint (rank preserved — no placement, per
 * the 4.2.1 design: the row reappears in `backlogRank` order).
 */
export function writeForPlan(plan: BacklogMovePlan): BacklogWrite {
  switch (plan.kind) {
    case 'reorder':
      return {
        url: `/api/work-items/${plan.activeId}/rank`,
        body: { beforeId: plan.beforeId, afterId: plan.afterId },
      };
    case 'assign':
      return {
        url: `/api/work-items/${plan.activeId}/sprint`,
        body: { sprintId: plan.target.sprintId, beforeId: plan.beforeId, afterId: plan.afterId },
      };
    case 'to-backlog':
      return {
        url: `/api/work-items/${plan.activeId}/sprint`,
        body: { sprintId: null },
      };
    case 'none':
      throw new Error('writeForPlan called on a no-op move');
  }
}

/** Move `activeId` to `insertAt` within one ordered list (a same-region reorder). Pure. */
export function arrayRelocate<T extends HasId>(
  items: T[],
  activeId: string,
  insertAt: number,
): T[] {
  const idx = items.findIndex((i) => i.id === activeId);
  if (idx === -1) return items;
  const moved = items[idx]!;
  const without = [...items.slice(0, idx), ...items.slice(idx + 1)];
  const clamped = Math.max(0, Math.min(insertAt, without.length));
  return [...without.slice(0, clamped), moved, ...without.slice(clamped)];
}

/** Drop `id` out of a list (the source side of a cross-region move). Pure. */
export function arrayRemove<T extends HasId>(items: T[], id: string): T[] {
  return items.filter((i) => i.id !== id);
}

/** Insert `item` at `insertAt` (clamped) — the target side of a cross-region move. Pure. */
export function arrayInsertAt<T extends HasId>(items: T[], item: T, insertAt: number): T[] {
  const clamped = Math.max(0, Math.min(insertAt, items.length));
  return [...items.slice(0, clamped), item, ...items.slice(clamped)];
}
