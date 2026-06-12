'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  DifferenceAreaChart,
  type DiffSeriesPoint,
} from '@/components/ui/charts/DifferenceAreaChart';
import { niceTicks } from '@/components/ui/charts/scale';
import type { AxisTick, ChartAxis } from '@/components/ui/charts/tokens';
import type { DashboardWidgetSourceDto } from '@/lib/dto/dashboards';
import type { CreatedVsResolvedConfig } from '@/lib/dashboards/widgetRegistry';
import type { CreatedVsResolvedDto, ReportPeriodDto } from '@/lib/dto/reports';
import { sourceParams, useWidgetData } from './useWidgetData';
import {
  WidgetEmpty,
  WidgetError,
  WidgetLoading,
  WidgetNoAccess,
  WidgetStale,
} from './WidgetStateView';

// The created-vs-resolved widget body (6.3.5 · rendererKind `difference_area`):
// the 6.3.4 two-series difference/area form over the 6.3.2 bucketed read.
// `cumulative` is just running-summed data (no separate form); the resolved
// series can dip negative on a reopen-heavy bucket, so the y-domain admits a
// floor at 0 or below.

const UNIT_KEY: Record<ReportPeriodDto, string> = {
  day: 'unitDay',
  week: 'unitWeek',
  month: 'unitMonth',
};

function bucketLabel(dateIso: string, period: ReportPeriodDto): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const opts: Intl.DateTimeFormatOptions =
    period === 'month'
      ? { month: 'short', year: '2-digit', timeZone: 'UTC' }
      : { month: 'short', day: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat('en-US', opts).format(d);
}

/** Pick ≤ `max` evenly-spread tick indices across `n` buckets (always the
 * first + last). */
function spreadTicks(n: number, max = 5): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (max - 1);
  const set = new Set<number>();
  for (let i = 0; i < max; i++) set.add(Math.round(i * step));
  return [...set].sort((a, b) => a - b);
}

export function CreatedVsResolvedBody({
  source,
  config,
  width = 560,
  height = 240,
  onReconfigure,
}: {
  source: DashboardWidgetSourceDto;
  config: CreatedVsResolvedConfig;
  width?: number;
  height?: number;
  onReconfigure?: () => void;
}) {
  const t = useTranslations('dashboards');

  const search = useMemo(() => {
    const params = sourceParams(source);
    if (!params) return null;
    params.set('period', config.period);
    params.set('daysBack', String(config.daysBack));
    if (config.cumulative) params.set('cumulative', 'true');
    return params.toString();
  }, [source, config.period, config.daysBack, config.cumulative]);

  const { state, reload } = useWidgetData<CreatedVsResolvedDto>(
    '/api/reports/created-vs-resolved',
    search,
  );

  if (source.kind === 'stale') return <WidgetStale onReconfigure={onReconfigure} />;
  if (state.phase === 'loading') return <WidgetLoading shape="chart" />;
  if (state.phase === 'error') return <WidgetError onRetry={reload} />;
  if (state.result.state === 'no_access') return <WidgetNoAccess />;
  if (state.result.state === 'stale') return <WidgetStale onReconfigure={onReconfigure} />;

  const data = state.result.data;
  if (data.buckets.length === 0) return <WidgetEmpty />;

  const created: DiffSeriesPoint[] = data.buckets.map((b, i) => ({ x: i, y: b.created }));
  const resolved: DiffSeriesPoint[] = data.buckets.map((b, i) => ({ x: i, y: b.resolved }));

  const n = data.buckets.length;
  const maxY = Math.max(1, ...data.buckets.flatMap((b) => [b.created, b.resolved]));
  const minY = Math.min(0, ...data.buckets.map((b) => b.resolved));
  const yTickValues = niceTicks(maxY, 4);
  const yTop = yTickValues[yTickValues.length - 1] ?? maxY;
  const xTicks: AxisTick[] = spreadTicks(n).map((i) => ({
    value: i,
    label: bucketLabel(data.buckets[i]!.date, config.period),
  }));

  const x: ChartAxis = {
    domain: [0, Math.max(1, n - 1)],
    ticks: xTicks,
    title: t(UNIT_KEY[config.period]),
  };
  const y: ChartAxis = {
    domain: [minY, yTop],
    ticks: yTickValues.map((v) => ({ value: v, label: String(v) })),
  };

  return (
    <div className="px-3.5 py-4">
      <DifferenceAreaChart
        created={created}
        resolved={resolved}
        x={x}
        y={y}
        width={width}
        height={height}
        description={t('cvrDesc', { period: t(UNIT_KEY[config.period]), days: data.daysBack })}
      />
    </div>
  );
}
