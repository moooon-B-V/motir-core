'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';
import type { BurndownSeriesDto } from '@/lib/dto/reports';
import { BurndownChart } from './BurndownChart';

// The sprint-report burndown SLOT (Story 4.6 · Subtask 4.6.5) — fills the chart
// seam Story 4.4.6 reserved with the FULL burndown form (charts.mock.html
// panels 1 + 5). The slot owns the load states so `SprintReport` stays
// presentational across both hosts:
//
//   • The standalone report page fetches `getBurndownSeries` SERVER-side and
//     passes the DTO — rendered directly, no client fetch.
//   • The complete-modal success state passes nothing — the slot fetches
//     `GET /api/sprints/[id]/burndown` client-side (the just-completed sprint),
//     with the chart-skeleton loading state (panel 4) and the host `ErrorState`
//     + retry on failure.
//
// Mirrors the CompleteSprintDialog fetch pattern (no SWR; `loading` flipped
// outside the effect — React 19 forbids set-state-in-effect).

type LoadState = 'loading' | 'ready' | 'error';

export function ReportBurndownSection({
  sprintId,
  burndown,
}: {
  sprintId: string;
  /** The server-fetched series (the standalone page); omit to client-fetch. */
  burndown?: BurndownSeriesDto;
}) {
  const t = useTranslations('backlog');
  const preloaded = burndown !== undefined;

  const [fetched, setFetched] = useState<BurndownSeriesDto | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (preloaded) return;
    let cancelled = false;
    void fetch(`/api/sprints/${sprintId}/burndown`, { headers: { accept: 'application/json' } })
      .then((res) =>
        res.ok ? (res.json() as Promise<BurndownSeriesDto>) : Promise.reject(res.status),
      )
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

  const data = burndown ?? fetched;
  if (data) return <BurndownChart burndown={data} variant="full" />;

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
