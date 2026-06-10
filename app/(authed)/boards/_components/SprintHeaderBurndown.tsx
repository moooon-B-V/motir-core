'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import type { BurndownSeriesDto } from '@/lib/dto/reports';
import {
  BurndownChart,
  burndownCutoffIndex,
} from '@/app/(authed)/backlog/_components/BurndownChart';

// The scrum-header burndown SLOT (Story 4.6 · Subtask 4.6.5) — fills the chart
// slot Story 4.5 reserved in the sprint header with the COMPACT in-sprint
// burndown (charts.mock.html panels 2 + 5): the guideline + the actual line
// drawn to "today", mounted BESIDE the committed/completed/remaining numbers,
// never replacing them (the seam contract). The slot is a quiet inset card with
// the uppercase label + the "day N of M" sub-line (the text signal panel 2's
// chart-sub carries; the compact chart itself hides the legend for density —
// its `<desc>` + data-table fallback still convey every series, finding #35).
//
// The board is client-fetched, so the slot fetches `GET
// /api/sprints/[id]/burndown` client-side too (the CompleteSprintDialog fetch
// pattern); loading shows the slot-sized skeleton, failure the compact
// error-state box with a Retry (panel 4 — the chart never invents page chrome).

type LoadState = 'loading' | 'ready' | 'error';

export function SprintHeaderBurndown({ sprintId }: { sprintId: string }) {
  const t = useTranslations('boards');
  const tc = useTranslations('common');

  const [burndown, setBurndown] = useState<BurndownSeriesDto | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/sprints/${sprintId}/burndown`, { headers: { accept: 'application/json' } })
      .then((res) =>
        res.ok ? (res.json() as Promise<BurndownSeriesDto>) : Promise.reject(res.status),
      )
      .then((data) => {
        if (cancelled) return;
        setBurndown(data);
        setLoadState('ready');
      })
      .catch(() => {
        if (!cancelled) setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [sprintId, reloadKey]);

  const day = burndown ? Math.max(burndownCutoffIndex(burndown.days), 0) : 0;
  const total = burndown ? Math.max(burndown.days.length - 1, 1) : 0;

  return (
    <div
      data-testid="sprint-burndown"
      className="flex w-[300px] shrink-0 flex-col gap-1 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) py-(--spacing-control-y)"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10.5px] font-semibold tracking-wide text-(--el-text-muted) uppercase">
          {t('burndownTitle')}
        </span>
        {burndown ? (
          <span className="text-[10.5px] text-(--el-text-faint)">
            {t('burndownDayOf', { day, total })}
          </span>
        ) : null}
      </div>

      {burndown ? (
        <BurndownChart burndown={burndown} variant="compact" />
      ) : loadState === 'error' ? (
        <div role="alert" className="flex flex-col items-center gap-1.5 py-3 text-center">
          <span className="text-xs text-(--el-text-muted)">{t('burndownErrorTitle')}</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setLoadState('loading');
              setReloadKey((k) => k + 1);
            }}
          >
            {tc('retry')}
          </Button>
        </div>
      ) : (
        <div
          role="status"
          aria-label={t('loadingLabel')}
          className="flex h-[120px] flex-col justify-end gap-1.5 py-1"
        >
          <div className="flex h-full items-end gap-1.5">
            {[55, 80, 45, 70, 90, 60].map((height, i) => (
              <span
                key={i}
                className="w-1/6 animate-pulse rounded-(--radius-control) bg-(--el-muted)"
                style={{ height: `${height}%` }}
              />
            ))}
          </div>
          <span className="h-2 w-2/3 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
        </div>
      )}
    </div>
  );
}
