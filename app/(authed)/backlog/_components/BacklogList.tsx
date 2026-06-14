'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ErrorState } from '@/components/ui/ErrorState';
import { useRowWindow } from '@/components/ui/useRowWindow';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import { BacklogSortableRow } from './BacklogRow';
import { useBacklogDnd, useRegisterRegion } from './BacklogDndProvider';
import type { RankedIssuePage, StatusByKey } from './backlogShared';
import type { RegionKind } from './backlogDnd';

// The ranked-issue list (Story 4.2 · render 4.2.3 · drag 4.2.4) — the BOUNDED,
// virtualized, lazy-loaded body shared by the backlog region AND each sprint
// container (finding #57: NEVER load-all). Two parts:
//   * `useRankedIssues(endpoint)` — owns one cursor-paginated read (page 1 on
//     mount, `loadMore()` appends the next cursor page). Exposes `totalCount`
//     (the aggregate, for the bounded count header — NOT a loaded-row tally) AND
//     the `itemsRef` + `setItems` / `setTotalCount` the 4.2.4 drag coordinator
//     reads/mutates to relocate a row across regions optimistically.
//   * `BacklogRows` — the presentational scroll viewport: a dnd-kit region
//     DROPPABLE wrapping a `SortableContext` of draggable rows, `useRowWindow`
//     virtualization (3.2.5 — only visible rows mount, plus the actively-dragged
//     node so a drag never detaches), a scroll-near-bottom lazy-load trigger, the
//     in-flight "Loading more…" / "All N loaded" end-cap, and the loading /
//     error / empty states (design/backlog panel 6).
//
// Binds to Story 4.1.4's `getBacklog` / `getSprintIssues` (via `/api/backlog` and
// `/api/sprints/[id]/issues`); the reorder / assign / move-to-backlog WRITES are
// the single-issue 4.1.4 routes the 4.2.4 coordinator fires on drop. Selection /
// bulk / inline-create wiring is Subtask 4.2.5 (the `+ Create issue` row is placed).

const ROW_ESTIMATE_PX = 40;
const ROW_GAP_PX = 2;
const LOAD_MORE_THRESHOLD_PX = 240;
// Rows on either side of the dragged row kept mounted alongside the window so a
// drag out of (or within) a virtualized list never loses its node (the 3.2.5
// board contract).
const DRAG_KEEP = 2;

type ListStatus = 'loading' | 'ready' | 'error';

export interface RankedIssuesState {
  items: WorkItemSummaryDto[];
  totalCount: number;
  status: ListStatus;
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
  /** Live items for synchronous reads inside the drag coordinator (4.2.4). */
  itemsRef: MutableRefObject<WorkItemSummaryDto[]>;
  /** Apply an optimistic relocation (the coordinator mutates the list on drop). */
  setItems: Dispatch<SetStateAction<WorkItemSummaryDto[]>>;
  /** Adjust the bounded aggregate count on a cross-region move (finding #57). */
  setTotalCount: Dispatch<SetStateAction<number>>;
}

/**
 * Owns a single endpoint's cursor-paginated read (page 1 + lazy `loadMore`).
 *
 * `refreshKey` is an EXTERNAL refetch signal: bumping it re-runs the page-1 read
 * (resetting to a fresh first page + authoritative `totalCount`) WITHOUT a
 * `retry()`-style loading flash — the current rows stay mounted until the new
 * page resolves. The backlog container bumps it after a sprint completes so the
 * MOVE's destination region (the target sprint card or the backlog) re-reads:
 * `refetchSprints` only re-fetches `/api/sprints` metadata (which sprints exist
 * + their counts), NOT each region's own `/api/sprints/[id]/issues` or
 * `/api/backlog` list, so without this the carried issues never appear until a
 * manual reload (bug 11).
 */
export function useRankedIssues(endpoint: string, refreshKey = 0): RankedIssuesState {
  const [items, setItems] = useState<WorkItemSummaryDto[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Guards a double-fire of loadMore (a scroll burst) — the in-flight cursor.
  const inFlight = useRef(false);

  // Mirror the live items so the drag coordinator (which reads on a pointer/key
  // event, well after commit) sees the current list synchronously. A passive
  // effect is enough — a drag can't fire before the first commit.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Page 1 (a retry refetch, or an external `refreshKey` bump). Resets the
  // accumulated list. `status` starts 'loading' and `retry()` flips it back
  // before bumping `reloadKey`, so the effect never calls setState
  // synchronously in its body (the board pattern). A `refreshKey` refresh leaves
  // `status` 'ready', so the existing rows stay on screen until the new page
  // lands (no flash) and then swap to the post-move set.
  useEffect(() => {
    let active = true;
    fetch(endpoint, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`backlog ${res.status}`);
        const page = (await res.json()) as RankedIssuePage;
        if (!active) return;
        setItems(page.items);
        setTotalCount(page.totalCount);
        setCursor(page.nextCursor);
        setHasMore(page.nextCursor !== null);
        setStatus('ready');
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => {
      active = false;
    };
  }, [endpoint, reloadKey, refreshKey]);

  const loadMore = useCallback(() => {
    if (inFlight.current || !cursor) return;
    inFlight.current = true;
    setLoadingMore(true);
    const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`;
    fetch(url, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`backlog page ${res.status}`);
        const page = (await res.json()) as RankedIssuePage;
        setItems((prev) => [...prev, ...page.items]);
        setTotalCount(page.totalCount);
        setCursor(page.nextCursor);
        setHasMore(page.nextCursor !== null);
      })
      .catch(() => {
        // A failed page leaves the loaded rows in place; the trigger re-arms so
        // scrolling again retries (no destructive state change).
      })
      .finally(() => {
        inFlight.current = false;
        setLoadingMore(false);
      });
  }, [endpoint, cursor]);

  const retry = useCallback(() => {
    setStatus('loading');
    setReloadKey((k) => k + 1);
  }, []);

  return {
    items,
    totalCount,
    status,
    loadingMore,
    hasMore,
    loadMore,
    retry,
    itemsRef,
    setItems,
    setTotalCount,
  };
}

export function BacklogRows({
  state,
  statusByKey,
  assigneeNameById,
  emptyState,
  createRow,
  createRowOnEmpty = false,
  ariaLabel,
  maxHeightClass = 'max-h-[60vh]',
  regionId,
  regionKind,
  regionLabel,
  regionOrder,
  sprintId,
}: {
  state: RankedIssuesState;
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
  /** Body shown when the read returns zero rows (EmptyState / dashed placeholder). */
  emptyState: ReactNode;
  /** The `+ Create issue` row (wired in Subtask 4.2.5 — creates into this region). */
  createRow?: ReactNode;
  /** Whether the create-row also shows in the empty case (sprints: yes). */
  createRowOnEmpty?: boolean;
  ariaLabel: string;
  maxHeightClass?: string;
  /** The dnd-kit droppable id for this region (4.2.4 — `BACKLOG_REGION_ID` / `sprintRegionId`). */
  regionId: string;
  regionKind: RegionKind;
  /** Human-readable region name for aria-live drag announcements. */
  regionLabel: string;
  /** Top-to-bottom position in the stack (sprints first, backlog last) — shift-range order (4.2.5). */
  regionOrder: number;
  /** The sprint id for a sprint region (so a cross-region move knows the target). */
  sprintId?: string;
}) {
  const t = useTranslations('backlog');
  const { items, totalCount, status, loadingMore, hasMore, loadMore, retry } = state;
  const { activeId } = useBacklogDnd();

  // Register this region with the drag coordinator (4.2.4). A collapsed sprint
  // unmounts its rows → this unmounts → it deregisters, so it is not a drop
  // target while collapsed. The refs/setters are stable across renders.
  useRegisterRegion({
    id: regionId,
    kind: regionKind,
    sprintId,
    label: regionLabel,
    order: regionOrder,
    itemsRef: state.itemsRef,
    setItems: state.setItems,
    setTotalCount: state.setTotalCount,
  });

  // The whole region is a droppable so a drop anywhere in it (incl. an empty
  // sprint / the backlog) resolves to this region; the row SortableContext
  // handles the slot. While a row is dragged over, the accent ring + lavender
  // tint mark it (paired with the per-row insertion bar — never colour-alone, #35).
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: regionId });

  const viewportRef = useRef<HTMLDivElement>(null);
  const getScrollElement = useCallback(() => viewportRef.current, []);
  const { containerRef, range, totalSize, getOffset, measureElement, windowing } = useRowWindow({
    count: items.length,
    estimateRowHeight: ROW_ESTIMATE_PX,
    gap: ROW_GAP_PX,
    getScrollElement,
  });

  // Lazy-load when the scroll nears the bottom (composes with virtualization —
  // a DOM sentinel is unreliable once rows above the window are unmounted).
  const onScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el || !hasMore || loadingMore) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_THRESHOLD_PX) loadMore();
  }, [hasMore, loadingMore, loadMore]);

  const dropClass = isOver
    ? 'rounded-(--radius-card) outline outline-2 outline-(--el-accent) bg-(--el-tint-lavender)'
    : '';

  if (status === 'loading') {
    return (
      <div ref={setDropRef} className={dropClass}>
        <div className="flex flex-col gap-(--spacing-sm) p-(--spacing-control-x)" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-9 animate-pulse rounded-(--radius-control) bg-(--el-muted)"
              data-testid="backlog-skeleton-row"
            />
          ))}
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div ref={setDropRef} className={dropClass}>
        <ErrorState title={t('errorTitle')} description={t('errorDescription')} retry={retry} />
      </div>
    );
  }

  if (totalCount === 0 && items.length === 0) {
    return (
      <div ref={setDropRef} className={dropClass}>
        {emptyState}
        {createRowOnEmpty ? createRow : null}
      </div>
    );
  }

  // The mounted indices: the virtualization window, plus the actively-dragged row
  // and its neighbours (so a drag out of the window never detaches). Whole list
  // when not windowing (e.g. happy-dom in tests has no measurable viewport).
  const indices: number[] = [];
  if (windowing) {
    const set = new Set<number>();
    for (let i = range.start; i < range.end; i++) set.add(i);
    if (activeId) {
      const ai = items.findIndex((it) => it.id === activeId);
      if (ai >= 0) {
        for (let j = ai - DRAG_KEEP; j <= ai + DRAG_KEEP; j++) {
          if (j >= 0 && j < items.length) set.add(j);
        }
      }
    }
    indices.push(...[...set].sort((a, b) => a - b));
  } else {
    for (let i = 0; i < items.length; i++) indices.push(i);
  }

  return (
    <div ref={setDropRef} className={dropClass}>
      <div
        ref={viewportRef}
        role="list"
        aria-label={ariaLabel}
        onScroll={onScroll}
        className={`overflow-y-auto ${maxHeightClass}`}
      >
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <div
            ref={containerRef}
            className={windowing ? 'relative' : 'flex flex-col gap-[2px]'}
            style={windowing ? { height: totalSize } : undefined}
          >
            {indices.map((index) => {
              const item = items[index]!;
              return (
                <div
                  key={item.id}
                  ref={measureElement(index)}
                  style={
                    windowing
                      ? { position: 'absolute', top: getOffset(index), left: 0, right: 0 }
                      : undefined
                  }
                >
                  <BacklogSortableRow
                    item={item}
                    statusByKey={statusByKey}
                    assigneeNameById={assigneeNameById}
                    regionKind={regionKind}
                    sprintId={sprintId}
                  />
                </div>
              );
            })}
          </div>
        </SortableContext>
        {/* Lazy-load end-cap (finding #57): in-flight spinner while a page
            loads; a quiet "all loaded" cap when the cursor is exhausted. */}
        {loadingMore ? (
          <div className="flex items-center justify-center gap-2 py-(--spacing-sm) text-xs text-(--el-text-muted)">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {t('loadingMore')}
          </div>
        ) : !hasMore && items.length > 0 ? (
          <div className="py-(--spacing-sm) text-center text-xs text-(--el-text-faint)">
            {t('allLoaded', { count: totalCount })}
          </div>
        ) : null}
      </div>
      {createRow}
    </div>
  );
}
