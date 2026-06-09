'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { ErrorState } from '@/components/ui/ErrorState';
import { useRowWindow } from '@/components/ui/useRowWindow';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import { BacklogRow } from './BacklogRow';
import type { RankedIssuePage, StatusByKey } from './backlogShared';

// The ranked-issue list (Story 4.2 · Subtask 4.2.3) — the BOUNDED, virtualized,
// lazy-loaded body shared by the backlog region AND each sprint container
// (finding #57: NEVER load-all). Two parts:
//   * `useRankedIssues(endpoint)` — owns one cursor-paginated read (page 1 on
//     mount, `loadMore()` appends the next cursor page). Exposes `totalCount`
//     (the aggregate, for the bounded count header — NOT a loaded-row tally).
//   * `BacklogRows` — the presentational scroll viewport: `useRowWindow`
//     virtualization (3.2.5 — only visible rows in the DOM), a scroll-near-bottom
//     lazy-load trigger, the in-flight "Loading more…" / "All N loaded" end-cap,
//     and the loading / error / empty states (per design/backlog panel 6).
//
// Binds to Story 4.1.4's `getBacklog` / `getSprintIssues` (via `/api/backlog`
// and `/api/sprints/[id]/issues`); no drag, no selection, no create wiring here
// (Subtasks 4.2.4 / 4.2.5). The `+ Create issue` row is PLACED (disabled).

const ROW_ESTIMATE_PX = 40;
const ROW_GAP_PX = 2;
const LOAD_MORE_THRESHOLD_PX = 240;

type ListStatus = 'loading' | 'ready' | 'error';

export interface RankedIssuesState {
  items: WorkItemSummaryDto[];
  totalCount: number;
  status: ListStatus;
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

/** Owns a single endpoint's cursor-paginated read (page 1 + lazy `loadMore`). */
export function useRankedIssues(endpoint: string): RankedIssuesState {
  const [items, setItems] = useState<WorkItemSummaryDto[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Guards a double-fire of loadMore (a scroll burst) — the in-flight cursor.
  const inFlight = useRef(false);

  // Page 1 (and a retry refetch). Resets the accumulated list. `status` starts
  // 'loading' and `retry()` flips it back before bumping `reloadKey`, so the
  // effect never calls setState synchronously in its body (the board pattern).
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
  }, [endpoint, reloadKey]);

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

  return { items, totalCount, status, loadingMore, hasMore, loadMore, retry };
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
}: {
  state: RankedIssuesState;
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
  /** Body shown when the read returns zero rows (EmptyState / dashed placeholder). */
  emptyState: ReactNode;
  /** The PLACED `+ Create issue` row (disabled; wired in Subtask 4.2.5). */
  createRow?: ReactNode;
  /** Whether the create-row also shows in the empty case (sprints: yes). */
  createRowOnEmpty?: boolean;
  ariaLabel: string;
  maxHeightClass?: string;
}) {
  const t = useTranslations('backlog');
  const { items, totalCount, status, loadingMore, hasMore, loadMore, retry } = state;

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

  if (status === 'loading') {
    return (
      <div className="flex flex-col gap-(--spacing-sm) p-(--spacing-control-x)" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-9 animate-pulse rounded-(--radius-control) bg-(--el-muted)"
            data-testid="backlog-skeleton-row"
          />
        ))}
      </div>
    );
  }

  if (status === 'error') {
    return <ErrorState title={t('errorTitle')} description={t('errorDescription')} retry={retry} />;
  }

  if (totalCount === 0 && items.length === 0) {
    return (
      <>
        {emptyState}
        {createRowOnEmpty ? createRow : null}
      </>
    );
  }

  const indices: number[] = [];
  if (windowing) {
    for (let i = range.start; i < range.end; i++) indices.push(i);
  } else {
    for (let i = 0; i < items.length; i++) indices.push(i);
  }

  return (
    <>
      <div
        ref={viewportRef}
        role="list"
        aria-label={ariaLabel}
        onScroll={onScroll}
        className={`overflow-y-auto ${maxHeightClass}`}
      >
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
                <BacklogRow
                  item={item}
                  statusByKey={statusByKey}
                  assigneeNameById={assigneeNameById}
                />
              </div>
            );
          })}
        </div>
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
    </>
  );
}
