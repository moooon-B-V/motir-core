'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import { useRowWindow } from '@/components/ui/useRowWindow';
import type { PlanStatusDto } from '@/lib/dto/plans';

import { loadMorePlansAction } from '../_actions';
import { PlanRow } from './PlanRow';
import type { PlanRowView } from './types';

// The Plans list (Subtask 7.21.1 / MOTIR-1338, design Panel A; tabbed and
// streamed by MOTIR-3241). Scale shape (finding #57), mirroring `/ready` +
// `/backlog`: the page server-renders the FIRST cursor page OF THE TAB IN VIEW;
// this VIRTUALIZES the loaded rows via the shipped `useRowWindow` primitive
// (only viewport rows mount; degrades to render-all under no measurable
// viewport, e.g. SSR/tests) and streams subsequent cursor pages via
// `loadMorePlansAction` — so neither the DOM nor the initial payload grows with
// the plan history, and nothing is silently capped. The client never touches the
// service layer (the action is the server boundary).
//
// ⚠️ THE `Load more` BUTTON IS GONE (MOTIR-3241). This file's header comment has
// claimed since MOTIR-1338 that it streams "as the virtualized list nears its
// end" — it did not. `loadMore` had exactly one caller and it was a button; the
// sentence described `ReadyList`, which this file was copied from. It is true
// now: the same bottom sentinel + `IntersectionObserver` + `rootMargin` +
// re-entrancy guard `ReadyList` ships, adopted verbatim rather than re-derived.

const ROW_ESTIMATE_PX = 64;
const ROW_GAP_PX = 8;
/** How far ahead of the viewport the sentinel fires — `ReadyList`'s own value. */
const LOAD_AHEAD_PX = 600;

export interface PlansListProps {
  initialViews: PlanRowView[];
  initialCursor: string | null;
  /** The tab these rows came from. It travels with every streamed page so a
   *  later page cannot arrive from a different status than the one that asked. */
  status: PlanStatusDto;
}

export function PlansList({ initialViews, initialCursor, status }: PlansListProps) {
  const t = useTranslations('aiPlanning');
  const [views, setViews] = useState<PlanRowView[]>(initialViews);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
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
    startTransition(async () => {
      try {
        const next = await loadMorePlansAction(cursor, status);
        setViews((prev) => [...prev, ...next.views]);
        setCursor(next.nextCursor);
      } finally {
        loadingRef.current = false;
      }
    });
  }, [cursor, status]);

  // Stream the next page as a bottom sentinel nears the viewport. Re-armed each
  // time the cursor advances; torn down at the tail (`cursor === null`), so a
  // reader sitting at the end of a finished list is not observing anything.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || cursor === null) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: `${LOAD_AHEAD_PX}px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

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
        aria-label={t('listAria')}
        className={windowing ? 'relative' : 'flex flex-col gap-2'}
        style={windowing ? { height: totalSize } : undefined}
      >
        {indices.map((index) => {
          // ⚠️ GUARDED, and not defensively — this dereference THROWS on a tab
          // switch (MOTIR-3241). `useRowWindow` keeps its window `range` in
          // `useState` and recomputes it in a post-render layout effect, so on
          // the render right after the row count DROPS — thirty rows deep in
          // `Approved`, switching to a two-row `Generating` — `range` still
          // holds the older, larger bounds and `views[index]` is `undefined`.
          // A non-null assertion there takes the whole page down. Rendering
          // nothing for one frame lets the layout effect re-window.
          //
          // A happy-dom component test CANNOT catch this: with no measurable
          // viewport the hook degrades to render-all, so `indices` is always in
          // range and the test passes while the browser crashes. The real-browser
          // assertion belongs to the story's E2E card.
          const view = views[index];
          if (!view) return null;
          return (
            <div
              key={view.id}
              role="listitem"
              ref={measureElement(index)}
              style={
                windowing
                  ? { position: 'absolute', top: getOffset(index), left: 0, right: 0 }
                  : undefined
              }
            >
              <PlanRow view={view} />
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
    </div>
  );
}
