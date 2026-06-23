'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';
import type { CycleGraphDto } from '@/lib/dto/reports';
import { CycleGraphChart } from './CycleGraphChart';

// The sprint-report cycle-graph SLOT (Story 4.6 · Subtask 4.6.5; reframed to the
// Linear cycle graph by Story 8.14 · 8.14.6) — fills the chart seam Story 4.4.6
// reserved with the FULL cycle-graph form (cycle-graph.mock.html). The slot owns
// the load states so `SprintReport` stays presentational across both hosts:
//
//   • The standalone report page fetches `getSprintCycleGraph` SERVER-side and
//     passes the DTO — rendered directly, no client fetch.
//   • The complete-modal success state passes nothing — the slot fetches
//     `GET /api/sprints/[id]/burndown` client-side (the path/label stay
//     "burndown"; the body is the cycle DTO), with the chart-skeleton loading
//     state and the host `ErrorState` + retry on failure.
//
// Mirrors the CompleteSprintDialog fetch pattern (no SWR; `loading` flipped
// outside the effect — React 19 forbids set-state-in-effect).

type LoadState = 'loading' | 'ready' | 'error';

export function ReportBurndownSection({
  sprintId,
  cycle,
}: {
  sprintId: string;
  /** The server-fetched cycle graph (the standalone page); omit to client-fetch. */
  cycle?: CycleGraphDto;
}) {
  const t = useTranslations('backlog');
  const preloaded = cycle !== undefined;

  const [fetched, setFetched] = useState<CycleGraphDto | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (preloaded) return;
    let cancelled = false;
    void fetch(`/api/sprints/${sprintId}/burndown`, { headers: { accept: 'application/json' } })
      .then((res) => (res.ok ? (res.json() as Promise<CycleGraphDto>) : Promise.reject(res.status)))
      .then((data) => {
        if (cancelled) return;
        setFetched(data);
        setLoadState('ready');
      })
      .catch(() => {
        if (!cancelled) setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [preloaded, sprintId, reloadKey]);

  const data = cycle ?? fetched;
  if (data) return <CycleGraphChart cycle={data} variant="full" />;

  if (loadState === 'error') {
    return (
      <ErrorState
        title={t('sprintReport.burndownErrorTitle')}
        description={t('sprintReport.burndownErrorBody')}
        retry={() => {
          setLoadState('loading');
          setReloadKey((k) => k + 1);
        }}
      />
    );
  }

  // The chart-slot skeleton (panel 4) — bars rising to a chart shape.
  return (
    <div
      role="status"
      aria-label={t('sprintReport.burndownLoading')}
      className="flex min-h-[200px] flex-col justify-end gap-2 rounded-(--radius-card) border border-(--el-border) px-(--spacing-card-padding) py-3"
    >
      <span className="h-3 w-2/5 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
      <div className="flex h-32 items-end gap-2">
        {[60, 85, 45, 70, 95, 55].map((height, i) => (
          <span
            key={i}
            className="w-1/6 animate-pulse rounded-(--radius-control) bg-(--el-muted)"
            style={{ height: `${height}%` }}
          />
        ))}
      </div>
      <span className="h-2.5 w-3/5 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
    </div>
  );
}
