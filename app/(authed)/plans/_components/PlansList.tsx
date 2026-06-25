'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import { useRowWindow } from '@/components/ui/useRowWindow';
import { Button } from '@/components/ui/Button';

import { loadMorePlansAction } from '../_actions';
import { PlanRow } from './PlanRow';
import type { PlanRowView } from './types';

// The Plans list (Subtask 7.21.1 / MOTIR-1338, design Panel A). Scale shape
// (finding #57), mirroring `/ready` + `/backlog`: the page server-renders the
// FIRST cursor page; this VIRTUALIZES the loaded rows via the shipped
// `useRowWindow` primitive (only viewport rows mount; degrades to render-all
// under no measurable viewport, e.g. SSR/tests) and streams subsequent cursor
// pages on demand via `loadMorePlansAction` — so neither the DOM nor the initial
// payload grows with the plan history, and nothing is silently capped. The
// client never touches the service layer (the action is the server boundary).

const ROW_ESTIMATE_PX = 64;
const ROW_GAP_PX = 8;

export interface PlansListProps {
  initialViews: PlanRowView[];
  initialCursor: string | null;
}

export function PlansList({ initialViews, initialCursor }: PlansListProps) {
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
        const next = await loadMorePlansAction(cursor);
        setViews((prev) => [...prev, ...next.views]);
        setCursor(next.nextCursor);
      } finally {
        loadingRef.current = false;
      }
    });
  }, [cursor]);

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
        {indices.map((index) => (
          <div
            key={views[index]!.id}
            role="listitem"
            ref={measureElement(index)}
            style={
              windowing
                ? { position: 'absolute', top: getOffset(index), left: 0, right: 0 }
                : undefined
            }
          >
            <PlanRow view={views[index]!} />
          </div>
        ))}
      </div>

      {cursor !== null ? (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={loadMore} disabled={isPending}>
            {isPending ? t('loadingMore') : t('loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
