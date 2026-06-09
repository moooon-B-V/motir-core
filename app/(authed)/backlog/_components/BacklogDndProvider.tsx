'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useTranslations } from 'next-intl';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useToast } from '@/components/ui/Toast';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CreateWorkItemInput, WorkItemDto, WorkItemSummaryDto } from '@/lib/dto/workItems';
import { BacklogRowOverlay } from './BacklogRow';
import { SelectionBar } from './SelectionBar';
import type { StatusByKey } from './backlogShared';
import {
  arrayInsertAt,
  arrayRelocate,
  arrayRemove,
  planBacklogMove,
  writeForPlan,
  type BacklogWrite,
  type RegionRef,
} from './backlogDnd';
import {
  boundaryRankWrite,
  bulkAssignWrite,
  bulkBacklogWrite,
  rangeIds,
  toRowSummary,
} from './backlogActions';

// The backlog interaction coordinator (Story 4.2 · Subtasks 4.2.4 drag + 4.2.5
// grooming). ONE `DndContext` over the whole backlog stack — the bottom backlog
// region + every (expanded) sprint container — so a row drags BETWEEN regions on
// the single global `backlogRank`, AND ONE selection model + ONE shared
// cross-region move executor the drag, the multi-select bulk bar, the row `⋯`
// menu, and the inline create all funnel through (no duplicate registry, no
// duplicate optimistic-write machinery).
//
// It reuses the Story-3.2 board move contract: a pointer sensor (8px activation,
// so a click never starts a drag) + a keyboard sensor (Space picks up, Escape
// cancels, arrows move), a `DragOverlay` lifted clone, optimistic application
// with SNAP-BACK on the server rejecting the write, and aria-live announcements.
//
// Each region (the backlog + each expanded sprint) REGISTERS a handle here via
// `useRegisterRegion` — its `order` (top-to-bottom rank, for shift-range
// selection), its live items ref + its `setItems` / `setTotalCount` setters — so
// the coordinator can read every region synchronously and relocate rows across
// regions on drop / bulk-move. The actual drag move is resolved ONCE on drop
// (`planBacklogMove`), NOT live on drag-over (the PRODECT_FINDINGS #61 / 3.3.8
// swimlane fix): drag-over only tracks the hovered region/row for the highlight.
//
// SELECTION (4.2.5): click selects · shift-click the range (over the flattened
// `order`) · ⌘/ctrl-click toggles one; the checkbox toggles. Selection is keyed
// by issue id, so it survives lazy-load + virtualized scroll. A drag begun on a
// row that is part of a multi-selection routes the WHOLE selection through the
// atomic bulk path (4.2.2), not N single moves.
//
// Counts: a cross-region move adjusts the source/target region's bounded
// `totalCount` (the count headers, finding #57) AND, for a sprint region, the
// sprint header's issue-count badge (via `adjustSprintCount`, threaded from the
// container's sprint state); a rejected write reverts both.

export interface BacklogRegionHandle extends RegionRef {
  /** Top-to-bottom position in the stack (sprints first, backlog last) — the flattened order shift-range reads. */
  order: number;
  /** Human-readable region name for aria-live announcements (sprint name / "Backlog"). */
  label: string;
  itemsRef: MutableRefObject<WorkItemSummaryDto[]>;
  setItems: Dispatch<SetStateAction<WorkItemSummaryDto[]>>;
  setTotalCount: Dispatch<SetStateAction<number>>;
}

/** A pending inline-create the "+ Create issue" row dispatches (Subtask 4.2.5). */
export interface CreateBacklogIssueInput {
  kind: CreateWorkItemInput['kind'];
  title: string;
  /** The target sprint, or null for the backlog. */
  sprintId: string | null;
}

interface BacklogDndContextValue {
  register: (handle: BacklogRegionHandle) => void;
  unregister: (id: string) => void;
  /** The id of the row currently being dragged (null when idle) — drives the ghost. */
  activeId: string | null;
  /** The row currently hovered as a drop target — drives the insertion bar. */
  overRowId: string | null;
  /** The region currently hovered — drives the drop-target ring + tint. */
  overRegionId: string | null;
  // ── Selection (4.2.5) ───────────────────────────────────────────────────────
  /** The selected issue ids (keyed by id → survives lazy-load / virtualized scroll). */
  selectedIds: ReadonlySet<string>;
  /** Plain click / shift-range / ⌘-toggle activation from a row body. */
  activateRow: (id: string, mods: { shiftKey: boolean; toggleKey: boolean }) => void;
  /** Toggle one row (the checkbox affordance). */
  toggleRow: (id: string) => void;
  /** Clear the whole selection (the bulk bar's "Clear", or after a bulk move). */
  clearSelection: () => void;
  // ── Grooming actions (4.2.5) — the shared cross-region executors ──────────────
  /** Move a set of issues into a sprint atomically (4.2.2 bulk assign). */
  moveItemsToSprint: (itemIds: string[], sprintId: string) => void;
  /** Move a set of issues back to the backlog atomically (4.2.2 bulk move). */
  moveItemsToBacklog: (itemIds: string[]) => void;
  /** Rank one issue to the top / bottom of its backlog region (4.1.4 rankIssue). */
  rankItemToBoundary: (itemId: string, edge: 'top' | 'bottom') => void;
  /** Inline-create an issue into the backlog or a sprint (4.2.2 createBacklogIssue). */
  createInto: (input: CreateBacklogIssueInput) => Promise<boolean>;
  /** The project's planning sprints — the `⋯` "Move to sprint ▸" + bulk-bar submenu. */
  sprints: SprintDto[];
}

const noop = () => {};
const BacklogDndContext = createContext<BacklogDndContextValue>({
  register: noop,
  unregister: noop,
  activeId: null,
  overRowId: null,
  overRegionId: null,
  selectedIds: new Set(),
  activateRow: noop,
  toggleRow: noop,
  clearSelection: noop,
  moveItemsToSprint: noop,
  moveItemsToBacklog: noop,
  rankItemToBoundary: noop,
  createInto: async () => false,
  sprints: [],
});

/** Read the coordinator (drag visuals + selection + grooming actions) inside a region/row. */
export function useBacklogDnd(): BacklogDndContextValue {
  return useContext(BacklogDndContext);
}

/**
 * Register a region's handle with the coordinator for the lifetime of the mounted
 * region (a collapsed sprint unmounts its rows → it deregisters, so it is not a
 * drop target / selection source while collapsed). The refs/setters are stable,
 * so this runs once per region id (re-runs only if its `order` changes).
 */
export function useRegisterRegion(handle: BacklogRegionHandle): void {
  const { register, unregister } = useBacklogDnd();
  const { id, order } = handle;
  useEffect(() => {
    register(handle);
    return () => unregister(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handle members are stable refs/setters; re-register only when id/order change
  }, [id, order, register, unregister]);
}

const POST_JSON = { 'content-type': 'application/json', accept: 'application/json' };

export function BacklogDndProvider({
  statusByKey,
  assigneeNameById,
  adjustSprintCount,
  sprints,
  children,
}: {
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
  /** Adjust a sprint header's issue-count badge (the container owns the sprint state). */
  adjustSprintCount: (sprintId: string, delta: number) => void;
  /** The planning sprints — fed to the row `⋯` menu + bulk bar "Move to sprint ▸". */
  sprints: SprintDto[];
  children: ReactNode;
}) {
  const t = useTranslations('backlog');
  const { toast } = useToast();

  const registry = useRef<Map<string, BacklogRegionHandle>>(new Map());
  const register = useCallback((handle: BacklogRegionHandle) => {
    registry.current.set(handle.id, handle);
  }, []);
  const unregister = useCallback((id: string) => {
    registry.current.delete(id);
  }, []);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeItem, setActiveItem] = useState<WorkItemSummaryDto | null>(null);
  const [overRowId, setOverRowId] = useState<string | null>(null);
  const [overRegionId, setOverRegionId] = useState<string | null>(null);

  // Selection (4.2.5). Keyed by issue id (survives lazy-load + virtualized
  // scroll); the anchor is the last plain/toggle pick, for shift-range.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  // A live mirror so the drag handlers (firing on a pointer event) read the
  // current selection synchronously without re-binding the callback.
  const selectedRef = useRef(selectedIds);
  useEffect(() => {
    selectedRef.current = selectedIds;
  }, [selectedIds]);
  // How many rows a multi-select drag carries (drives the overlay's N badge).
  const [dragCount, setDragCount] = useState(1);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );

  // Synchronous registry reads (a dnd lifecycle event can fire before a setState
  // re-render): the handle's `itemsRef` is always the region's live items.
  const regionContaining = useCallback((itemId: string): BacklogRegionHandle | null => {
    for (const handle of registry.current.values()) {
      if (handle.itemsRef.current.some((i) => i.id === itemId)) return handle;
    }
    return null;
  }, []);
  const regionOfOver = useCallback(
    (overId: string): BacklogRegionHandle | null =>
      registry.current.get(overId) ?? regionContaining(overId),
    [regionContaining],
  );
  const itemOf = useCallback(
    (itemId: string): WorkItemSummaryDto | null =>
      regionContaining(itemId)?.itemsRef.current.find((i) => i.id === itemId) ?? null,
    [regionContaining],
  );
  const regionOfSprint = useCallback((sprintId: string): BacklogRegionHandle | null => {
    for (const handle of registry.current.values()) {
      if (handle.kind === 'sprint' && handle.sprintId === sprintId) return handle;
    }
    return null;
  }, []);
  const backlogRegion = useCallback((): BacklogRegionHandle | null => {
    for (const handle of registry.current.values()) {
      if (handle.kind === 'backlog') return handle;
    }
    return null;
  }, []);
  /** The flattened top-to-bottom id order across all mounted regions (shift-range). */
  const orderedIds = useCallback((): string[] => {
    const regions = [...registry.current.values()].sort((a, b) => a.order - b.order);
    return regions.flatMap((r) => r.itemsRef.current.map((i) => i.id));
  }, []);

  // ── Selection handlers ──────────────────────────────────────────────────────
  const activateRow = useCallback(
    (id: string, mods: { shiftKey: boolean; toggleKey: boolean }) => {
      if (mods.shiftKey && anchorRef.current) {
        setSelectedIds(new Set(rangeIds(orderedIds(), anchorRef.current, id)));
        return;
      }
      if (mods.toggleKey) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        anchorRef.current = id;
        return;
      }
      setSelectedIds(new Set([id]));
      anchorRef.current = id;
    },
    [orderedIds],
  );
  const toggleRow = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchorRef.current = id;
  }, []);
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    anchorRef.current = null;
  }, []);

  // ── The shared optimistic-write runner ───────────────────────────────────────
  // Assumes the optimistic relocation has already been applied; fires the write
  // and runs `revert` (which restores state + toasts) on rejection. The drag, the
  // bulk bar, the `⋯` menu, and the inline create all funnel through it.
  const runWrite = useCallback((write: BacklogWrite, revert: () => void) => {
    void fetch(write.url, { method: 'POST', headers: POST_JSON, body: JSON.stringify(write.body) })
      .then((res) => {
        if (!res.ok) revert();
      })
      .catch(revert);
  }, []);

  // ── The shared cross-region BULK executor (bulk bar · ⋯ menu · multi-drag) ────
  // `targetSprintId === null` → move to backlog; otherwise → assign to that
  // sprint. Optimistically removes each moved row from its source region and
  // appends it to the (mounted) target, adjusting the bounded list counts + the
  // sprint header badges; fires ONE atomic 4.2.2 request; snaps everything back
  // on rejection.
  const executeBulk = useCallback(
    (rawIds: string[], targetSprintId: string | null) => {
      const targetRegion = targetSprintId ? regionOfSprint(targetSprintId) : backlogRegion();
      // Resolve the actual moves: skip ids already in the target scope (+ dups).
      const moves: {
        id: string;
        item: WorkItemSummaryDto | null;
        src: BacklogRegionHandle | null;
      }[] = [];
      const seen = new Set<string>();
      for (const id of rawIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        const src = regionContaining(id);
        const srcSprintId = src?.sprintId ?? null;
        if (srcSprintId === targetSprintId) continue; // already where it would land
        moves.push({ id, item: itemOf(id), src });
      }
      if (moves.length === 0) return;
      const ids = moves.map((m) => m.id);

      // Snapshot every touched region's items + record count deltas for revert.
      const itemSnaps: { handle: BacklogRegionHandle; items: WorkItemSummaryDto[] }[] = [];
      const totalDeltas: { handle: BacklogRegionHandle; delta: number }[] = [];
      const sprintDeltas: { sprintId: string; delta: number }[] = [];
      const snapItems = (h: BacklogRegionHandle) => {
        if (!itemSnaps.some((s) => s.handle.id === h.id)) {
          itemSnaps.push({ handle: h, items: h.itemsRef.current });
        }
      };

      // Remove from sources, grouped by source region.
      const bySource = new Map<string, { handle: BacklogRegionHandle; ids: Set<string> }>();
      for (const m of moves) {
        if (!m.src) continue; // source not mounted — counted server-side, no optimistic row op
        const g = bySource.get(m.src.id) ?? { handle: m.src, ids: new Set<string>() };
        g.ids.add(m.id);
        bySource.set(m.src.id, g);
      }
      for (const { handle, ids: removeIds } of bySource.values()) {
        snapItems(handle);
        handle.setItems((prev) => prev.filter((i) => !removeIds.has(i.id)));
        handle.setTotalCount((c) => Math.max(0, c - removeIds.size));
        totalDeltas.push({ handle, delta: -removeIds.size });
        if (handle.kind === 'sprint' && handle.sprintId) {
          adjustSprintCount(handle.sprintId, -removeIds.size);
          sprintDeltas.push({ sprintId: handle.sprintId, delta: -removeIds.size });
        }
      }

      // Insert into the (mounted) target; always bump the target's count/badge.
      const movedItems = moves
        .map((m) => m.item)
        .filter((i): i is WorkItemSummaryDto => i !== null);
      if (targetRegion) {
        snapItems(targetRegion);
        targetRegion.setItems((prev) => {
          const present = new Set(prev.map((i) => i.id));
          return [...prev, ...movedItems.filter((i) => !present.has(i.id))];
        });
        targetRegion.setTotalCount((c) => c + moves.length);
        totalDeltas.push({ handle: targetRegion, delta: moves.length });
      }
      if (targetSprintId) {
        adjustSprintCount(targetSprintId, moves.length);
        sprintDeltas.push({ sprintId: targetSprintId, delta: moves.length });
      }

      const revert = () => {
        for (const { handle, items } of itemSnaps) handle.setItems(items);
        for (const { handle, delta } of totalDeltas) handle.setTotalCount((c) => c - delta);
        for (const { sprintId, delta } of sprintDeltas) adjustSprintCount(sprintId, -delta);
        toast({
          variant: 'error',
          title: t('moveRejectedTitle'),
          description: t('bulkErrorDescription'),
        });
      };

      const write = targetSprintId ? bulkAssignWrite(targetSprintId, ids) : bulkBacklogWrite(ids);
      runWrite(write, revert);
    },
    [
      adjustSprintCount,
      backlogRegion,
      itemOf,
      regionContaining,
      regionOfSprint,
      runWrite,
      t,
      toast,
    ],
  );

  const moveItemsToSprint = useCallback(
    (itemIds: string[], sprintId: string) => {
      executeBulk(itemIds, sprintId);
      clearSelection();
    },
    [clearSelection, executeBulk],
  );
  const moveItemsToBacklog = useCallback(
    (itemIds: string[]) => {
      executeBulk(itemIds, null);
      clearSelection();
    },
    [clearSelection, executeBulk],
  );

  // Rank one row to the top / bottom of its backlog region (the `⋯` menu). A
  // same-region reorder: a single-row `rankIssue` write, optimistic + snap-back.
  const rankItemToBoundary = useCallback(
    (itemId: string, edge: 'top' | 'bottom') => {
      const region = regionContaining(itemId);
      if (!region) return;
      const others = region.itemsRef.current.filter((i) => i.id !== itemId);
      if (others.length === 0) return; // sole row — already at both boundaries
      const neighbourId = edge === 'top' ? others[0]!.id : others[others.length - 1]!.id;
      const snapshot = region.itemsRef.current;
      region.setItems((prev) => arrayRelocate(prev, itemId, edge === 'top' ? 0 : prev.length - 1));
      const revert = () => {
        region.setItems(snapshot);
        toast({
          variant: 'error',
          title: t('moveRejectedTitle'),
          description: t('bulkErrorDescription'),
        });
      };
      runWrite(boundaryRankWrite(itemId, edge, neighbourId), revert);
    },
    [regionContaining, runWrite, t, toast],
  );

  // Inline create into the backlog or a sprint (4.2.2 createBacklogIssue). Awaits
  // the 201, then appends the new row to the (mounted) target in place + bumps
  // the count/badge. Returns whether it succeeded (the row resets its draft).
  const createInto = useCallback(
    async (input: CreateBacklogIssueInput): Promise<boolean> => {
      try {
        const res = await fetch('/api/backlog', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ kind: input.kind, title: input.title, sprintId: input.sprintId }),
        });
        if (!res.ok) throw new Error(`create ${res.status}`);
        const dto = (await res.json()) as WorkItemDto;
        const summary = toRowSummary(dto);
        const target = input.sprintId ? regionOfSprint(input.sprintId) : backlogRegion();
        if (target) {
          target.setItems((prev) => [...prev, summary]);
          target.setTotalCount((c) => c + 1);
        }
        if (input.sprintId) adjustSprintCount(input.sprintId, 1);
        return true;
      } catch {
        toast({
          variant: 'error',
          title: t('createIssueErrorTitle'),
          description: t('createIssueErrorDescription'),
        });
        return false;
      }
    },
    [adjustSprintCount, backlogRegion, regionOfSprint, t, toast],
  );

  // ── Drag lifecycle ───────────────────────────────────────────────────────────
  const handleDragStart = useCallback(
    (e: DragStartEvent) => {
      const id = String(e.active.id);
      setActiveId(id);
      setActiveItem(itemOf(id));
      // A drag begun on a selected row carries the WHOLE selection (the N badge);
      // otherwise it is a single-row drag (selection is irrelevant to it).
      const sel = selectedRef.current;
      setDragCount(sel.has(id) && sel.size > 1 ? sel.size : 1);
    },
    [itemOf],
  );

  const handleDragOver = useCallback(
    (e: DragOverEvent) => {
      const overId = e.over ? String(e.over.id) : null;
      if (!overId) {
        setOverRowId(null);
        setOverRegionId(null);
        return;
      }
      const region = regionOfOver(overId);
      setOverRegionId(region?.id ?? null);
      // A region's droppable id is registered; anything else is a row.
      setOverRowId(registry.current.has(overId) ? null : overId);
    },
    [regionOfOver],
  );

  const clearDrag = useCallback(() => {
    setActiveId(null);
    setActiveItem(null);
    setOverRowId(null);
    setOverRegionId(null);
    setDragCount(1);
  }, []);

  const refOf = (handle: BacklogRegionHandle): RegionRef => ({
    id: handle.id,
    kind: handle.kind,
    sprintId: handle.sprintId,
  });

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      const activeIdStr = String(e.active.id);
      const over = e.over ? String(e.over.id) : null;
      clearDrag();
      if (!over) return;

      const source = regionContaining(activeIdStr);
      const target = regionOfOver(over);
      if (!source || !target) return;

      // Multi-select drag: a CROSS-region drop of a selection routes the WHOLE
      // selection through the atomic bulk path (4.2.2), not N single writes.
      const sel = selectedRef.current;
      const isMulti = sel.has(activeIdStr) && sel.size > 1;
      if (isMulti && source.id !== target.id) {
        executeBulk([...sel], target.kind === 'backlog' ? null : (target.sprintId ?? null));
        clearSelection();
        return;
      }

      const sourceItems = source.itemsRef.current;
      const sourceIndex = sourceItems.findIndex((i) => i.id === activeIdStr);
      const moved = sourceItems[sourceIndex];
      if (!moved) return;

      const plan = planBacklogMove({
        source: refOf(source),
        target: refOf(target),
        activeId: activeIdStr,
        targetItems: target.itemsRef.current,
        sourceIndex,
        overId: over,
        overIsRegion: registry.current.has(over),
      });
      if (plan.kind === 'none') return;

      // Snapshot the pre-move arrays for a clean snap-back on rejection.
      const sourceSnapshot = sourceItems;
      const targetSnapshot = target.itemsRef.current;
      const crossRegion = plan.kind !== 'reorder';

      // Optimistic application.
      if (!crossRegion) {
        source.setItems((prev) => arrayRelocate(prev, activeIdStr, plan.insertAt));
      } else {
        source.setItems((prev) => arrayRemove(prev, activeIdStr));
        target.setItems((prev) => arrayInsertAt(prev, moved, plan.insertAt));
        source.setTotalCount((c) => Math.max(0, c - 1));
        target.setTotalCount((c) => c + 1);
        if (source.kind === 'sprint' && source.sprintId) adjustSprintCount(source.sprintId, -1);
        if (target.kind === 'sprint' && target.sprintId) adjustSprintCount(target.sprintId, 1);
      }

      const revert = () => {
        source.setItems(sourceSnapshot);
        if (crossRegion) {
          target.setItems(targetSnapshot);
          source.setTotalCount((c) => c + 1);
          target.setTotalCount((c) => Math.max(0, c - 1));
          if (source.kind === 'sprint' && source.sprintId) adjustSprintCount(source.sprintId, 1);
          if (target.kind === 'sprint' && target.sprintId) adjustSprintCount(target.sprintId, -1);
        }
        toast({
          variant: 'error',
          title: t('moveRejectedTitle'),
          description: t('moveErrorDescription', { key: moved.identifier }),
        });
      };

      runWrite(writeForPlan(plan), revert);
    },
    [
      adjustSprintCount,
      clearDrag,
      clearSelection,
      executeBulk,
      regionContaining,
      regionOfOver,
      runWrite,
      t,
      toast,
    ],
  );

  const handleDragCancel = useCallback(() => clearDrag(), [clearDrag]);

  const announcements = useMemo<Announcements>(() => {
    const keyOf = (id: string) => itemOf(id)?.identifier ?? id;
    const labelOfOver = (overId: string) => regionOfOver(overId)?.label ?? '';
    return {
      onDragStart: ({ active }) => t('announcementPickedUp', { key: keyOf(String(active.id)) }),
      onDragOver: ({ active, over }) =>
        over
          ? t('announcementOver', {
              key: keyOf(String(active.id)),
              region: labelOfOver(String(over.id)),
            })
          : undefined,
      onDragEnd: ({ active, over }) =>
        over
          ? t('announcementDropped', {
              key: keyOf(String(active.id)),
              region: labelOfOver(String(over.id)),
            })
          : t('announcementCancelled', { key: keyOf(String(active.id)) }),
      onDragCancel: ({ active }) => t('announcementCancelled', { key: keyOf(String(active.id)) }),
    };
  }, [itemOf, regionOfOver, t]);

  const ctx = useMemo<BacklogDndContextValue>(
    () => ({
      register,
      unregister,
      activeId,
      overRowId,
      overRegionId,
      selectedIds,
      activateRow,
      toggleRow,
      clearSelection,
      moveItemsToSprint,
      moveItemsToBacklog,
      rankItemToBoundary,
      createInto,
      sprints,
    }),
    [
      register,
      unregister,
      activeId,
      overRowId,
      overRegionId,
      selectedIds,
      activateRow,
      toggleRow,
      clearSelection,
      moveItemsToSprint,
      moveItemsToBacklog,
      rankItemToBoundary,
      createInto,
      sprints,
    ],
  );

  return (
    <BacklogDndContext.Provider value={ctx}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: t('dndInstructions') },
        }}
      >
        <SelectionBar />
        {children}
        <DragOverlay>
          {activeItem ? (
            <BacklogRowOverlay
              item={activeItem}
              statusByKey={statusByKey}
              assigneeNameById={assigneeNameById}
              count={dragCount}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </BacklogDndContext.Provider>
  );
}
