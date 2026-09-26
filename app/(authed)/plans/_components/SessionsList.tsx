'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';

import { useRowWindow } from '@/components/ui/useRowWindow';
import type { PlanSessionStateDto } from '@/lib/dto/planSessions';

import { loadMoreSessionsAction } from '../_actions';
import { SessionRow } from './SessionRow';
import type { SessionRowView } from './types';
import type { RoomView } from '@/lib/rooms/roomView';

// The Plans list of planning CONVERSATIONS (MOTIR-6025, design Part XIX §19.1 /
// §19.5), the successor of `PlansList`. Same scale shape (finding #57): the page
// server-renders the FIRST cursor page of the filter in view; this virtualizes
// the loaded rows with the shipped `useRowWindow` and streams the next page as a
// bottom sentinel nears the viewport, through `loadMoreSessionsAction`.
//
// Two things the retired list did not do (§19.5):
//   · A page that FAILS to load says so and offers Retry on the same cursor —
//     `PlansList` swallowed the failure in a `finally`, so a reader at the end
//     of a broken list saw nothing at all.
//   · `?session=<id>` lands on that row: highlighted, and scrolled into view once.

const ROW_ESTIMATE_PX = 64;
const ROW_GAP_PX = 8;
/** How far ahead of the viewport the sentinel fires — `ReadyList`'s own value. */
const LOAD_AHEAD_PX = 600;

export interface SessionsListProps {
  initialViews: SessionRowView[];
  initialCursor: string | null;
  /** The filter these rows came from; it travels with every streamed page, so a
   *  later page cannot arrive from a different predicate than the one that asked. */
  planState: PlanSessionStateDto | null;
  /** The SERVED view (MOTIR-6334) — it travels with every streamed page like the
   *  filter does, and the page keys this island on it so a switch remounts. */
  view: RoomView;
  /** The `?session=<id>` row to highlight and scroll to, if any. */
  highlightId?: string | null;
}

export function SessionsList({
  initialViews,
  initialCursor,
  planState,
  view,
  highlightId = null,
}: SessionsListProps) {
  const t = useTranslations('aiPlanning');
  const ts = useTranslations('aiPlanning.sessions');
  const [views, setViews] = useState<SessionRowView[]>(initialViews);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [failed, setFailed] = useState(false);
  const [isPending, startTransition] = useTransition();
  // Guards re-entrancy: one load is in flight at a time.
  const loadingRef = useRef(false);

  const { containerRef, range, totalSize, getOffset, measureElement, windowing } = useRowWindow({
    count: views.length,
    estimateRowHeight: ROW_ESTIMATE_PX,
    gap: ROW_GAP_PX,
  });

  const loadMore = useCallback(() => {
    if (loadingRef.current || cursor === null) return;
    loadingRef.current = true;
    setFailed(false);
    startTransition(async () => {
      try {
        const next = await loadMoreSessionsAction(cursor, planState, view);
        // A landed-on row may have been pinned to the top of the first page
        // from further down the list; when its own page arrives it is not
        // listed twice.
        setViews((prev) => {
          const seen = new Set(prev.map((v) => v.id));
          return [...prev, ...next.views.filter((v) => !seen.has(v.id))];
        });
        setCursor(next.nextCursor);
      } catch {
        // The cursor is kept, so Retry re-runs the same page.
        setFailed(true);
      } finally {
        loadingRef.current = false;
      }
    });
  }, [cursor, planState, view]);

  // Stream the next page as a bottom sentinel nears the viewport. Torn down at
  // the tail and while a failed page waits on Retry — the observer must not
  // retry a broken page on its own in a loop.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || cursor === null || failed) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: `${LOAD_AHEAD_PX}px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, failed, loadMore]);

  // The `?session=` landing: scroll the row into view ONCE, on arrival.
  useEffect(() => {
    if (!highlightId) return;
    const row = containerRef.current?.querySelector(
      `[data-session-row="${CSS.escape(highlightId)}"]`,
    );
    row?.scrollIntoView({ block: 'center' });
    // Arrival only — a later page must not yank the reader back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const indices: number[] = [];
  if (windowing) {
    for (let i = range.start; i < range.end; i++) indices.push(i);
  } else {
    for (let i = 0; i < views.length; i++) indices.push(i);
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        ref={containerRef}
        role="list"
        aria-label={ts('listAria')}
        className={windowing ? 'relative' : 'flex flex-col gap-2'}
        style={windowing ? { height: totalSize } : undefined}
      >
        {indices.map((index) => {
          // ⚠️ GUARDED (MOTIR-3241): right after the row count DROPS,
          // `useRowWindow`'s range still holds the older, larger bounds for one
          // render, and `views[index]` is `undefined`.
          const view = views[index];
          if (!view) return null;
          return (
            <div
              key={view.id}
              role="listitem"
              data-session-row={view.id}
              ref={measureElement(index)}
              style={
                windowing
                  ? { position: 'absolute', top: getOffset(index), left: 0, right: 0 }
                  : undefined
              }
            >
              <SessionRow view={view} highlighted={view.id === highlightId} />
            </div>
          );
        })}
      </div>

      {/* Cursor sentinel — present only while more pages remain. */}
      {cursor !== null ? <div ref={sentinelRef} aria-hidden className="h-px w-full" /> : null}
      {isPending ? (
        <p className="text-center text-xs text-(--el-text-muted)" role="status">
          {t('loadingMore')}
        </p>
      ) : null}
      {failed && !isPending ? (
        <p
          className="flex items-center justify-center gap-2 text-xs text-(--el-text-secondary)"
          role="alert"
        >
          {ts('loadMoreError')}
          <button
            type="button"
            onClick={loadMore}
            className="inline-flex items-center gap-1 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-xs font-medium text-(--el-text-strong) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <RefreshCw className="size-3" aria-hidden />
            {ts('loadMoreRetry')}
          </button>
        </p>
      ) : null}
    </div>
  );
}
