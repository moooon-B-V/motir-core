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
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import { BacklogRowOverlay } from './BacklogRow';
import type { StatusByKey } from './backlogShared';
import {
  arrayInsertAt,
  arrayRelocate,
  arrayRemove,
  planBacklogMove,
  writeForPlan,
  type RegionRef,
} from './backlogDnd';

// The backlog drag coordinator (Story 4.2 · Subtask 4.2.4). ONE `DndContext` over
// the whole backlog stack — the bottom backlog region + every (expanded) sprint
// container — so a row drags BETWEEN regions on the single global `backlogRank`.
// It reuses the Story-3.2 board move contract: a pointer sensor (8px activation,
// so a click never starts a drag) + a keyboard sensor (Space picks up, Escape
// cancels, arrows move), a `DragOverlay` lifted clone, optimistic application
// with SNAP-BACK on the server rejecting the write, and aria-live announcements.
//
// Each region (the backlog + each expanded sprint) REGISTERS a handle here via
// `useRegisterRegion` — its live items ref + its `setItems` / `setTotalCount`
// setters — so the coordinator can read every region synchronously and relocate
// a row across two regions on drop. The actual move is resolved ONCE on drop
// (`planBacklogMove`), NOT live on drag-over: the regions are variable-height
// drop targets, and relocating live would loop the dnd-kit re-measure cycle that
// PRODECT_FINDINGS #61 hit on the swimlane board — so, exactly like the 3.3.8
// swimlane fix, drag-over only tracks the hovered region/row for the drop
// highlight and the `DragOverlay` carries the in-flight visual.
//
// Counts: a cross-region move adjusts the source/target region's bounded
// `totalCount` (the count headers, finding #57) AND, for a sprint region, the
// sprint header's issue-count badge (via `adjustSprintCount`, threaded from the
// container's sprint state); a rejected write reverts both.

export interface BacklogRegionHandle extends RegionRef {
  /** Human-readable region name for aria-live announcements (sprint name / "Backlog"). */
  label: string;
  itemsRef: MutableRefObject<WorkItemSummaryDto[]>;
  setItems: Dispatch<SetStateAction<WorkItemSummaryDto[]>>;
  setTotalCount: Dispatch<SetStateAction<number>>;
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
}

const noop = () => {};
const BacklogDndContext = createContext<BacklogDndContextValue>({
  register: noop,
  unregister: noop,
  activeId: null,
  overRowId: null,
  overRegionId: null,
});

/** Read the live drag state (ghost / insertion bar / drop ring) inside a region/row. */
export function useBacklogDnd(): BacklogDndContextValue {
  return useContext(BacklogDndContext);
}

/**
 * Register a region's drag handle with the coordinator for the lifetime of the
 * mounted region (a collapsed sprint unmounts its rows → it deregisters, so it is
 * not a drop target while collapsed). The refs/setters are stable, so this runs
 * once per region id.
 */
export function useRegisterRegion(handle: BacklogRegionHandle): void {
  const { register, unregister } = useBacklogDnd();
  // The handle object is rebuilt each render, but its members (a ref + useState
  // setters) are stable — key the effect on the identity that matters (the id +
  // the stable setters) so it registers once and re-registers only if they swap.
  const { id } = handle;
  useEffect(() => {
    register(handle);
    return () => unregister(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handle members are stable refs/setters; re-registering every render would thrash the registry
  }, [id, register, unregister]);
}

const POST_JSON = { 'content-type': 'application/json', accept: 'application/json' };

export function BacklogDndProvider({
  statusByKey,
  assigneeNameById,
  adjustSprintCount,
  children,
}: {
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
  /** Adjust a sprint header's issue-count badge (the container owns the sprint state). */
  adjustSprintCount: (sprintId: string, delta: number) => void;
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

  const handleDragStart = useCallback(
    (e: DragStartEvent) => {
      const id = String(e.active.id);
      setActiveId(id);
      setActiveItem(itemOf(id));
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

      const { url, body } = writeForPlan(plan);
      void fetch(url, { method: 'POST', headers: POST_JSON, body: JSON.stringify(body) })
        .then((res) => {
          if (!res.ok) revert();
        })
        .catch(revert);
    },
    [adjustSprintCount, clearDrag, regionContaining, regionOfOver, t, toast],
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
    () => ({ register, unregister, activeId, overRowId, overRegionId }),
    [register, unregister, activeId, overRowId, overRegionId],
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
        {children}
        <DragOverlay>
          {activeItem ? (
            <BacklogRowOverlay
              item={activeItem}
              statusByKey={statusByKey}
              assigneeNameById={assigneeNameById}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </BacklogDndContext.Provider>
  );
}
