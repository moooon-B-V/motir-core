'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { BarChart, type BarGroup } from '@/components/ui/charts/BarChart';
import { niceTicks } from '@/components/ui/charts/scale';
import { chartColor } from '@/components/ui/charts/tokens';
import type { DashboardWidgetSourceDto } from '@/lib/dto/dashboards';
import type { AgeReportConfig } from '@/lib/dashboards/widgetRegistry';
import type { AverageAgeDto, ReportPeriodDto } from '@/lib/dto/reports';
import { sourceParams, useWidgetData } from './useWidgetData';
import {
  WidgetEmpty,
  WidgetError,
  WidgetLoading,
  WidgetNoAccess,
  WidgetStale,
} from './WidgetStateView';

// The average-age / resolution-time widget body (8.8.13 · rendererKind `bar`):
// the 4.6.2 vertical BarChart over the 8.8.13 (period, daysBack) window read.
// One series of per-bucket day-averages + a dashed window-average reference
// line; an event-less bucket (`avgDays: null`) draws "—" not a misleading "0"
// (the 4.5.2 rule). The two report types share this body — they differ only in
// the endpoint, the bar colour token, and the legend/description copy.

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

export function AgeReportBody({
  type,
  source,
  config,
  width = 560,
  height = 240,
  onReconfigure,
}: {
  type: 'average_age' | 'resolution_time';
  source: DashboardWidgetSourceDto;
  config: AgeReportConfig;
  width?: number;
  height?: number;
  onReconfigure?: () => void;
}) {
  const t = useTranslations('dashboards');

  const isResolution = type === 'resolution_time';
  const endpoint = isResolution ? '/api/reports/resolution-time' : '/api/reports/average-age';
  const barColor = isResolution ? chartColor.resolution : chartColor.age;
  const descKey = isResolution ? 'barDescResolution' : 'barDescAge';
  const legendKey = isResolution ? 'barLegendResolution' : 'barLegendAge';

  const search = useMemo(() => {
    const params = sourceParams(source);
    if (!params) return null;
    params.set('period', config.period);
    params.set('daysBack', String(config.daysBack));
    return params.toString();
  }, [source, config.period, config.daysBack]);

  const { state, reload } = useWidgetData<AverageAgeDto>(endpoint, search);

  if (source.kind === 'stale') return <WidgetStale onReconfigure={onReconfigure} />;
  if (state.phase === 'loading') return <WidgetLoading shape="chart" />;
  if (state.phase === 'error') return <WidgetError onRetry={reload} />;
  if (state.result.state === 'no_access') return <WidgetNoAccess />;
  if (state.result.state === 'stale') return <WidgetStale onReconfigure={onReconfigure} />;

  const data = state.result.data;
  const hasData = data.buckets.some((b) => b.avgDays !== null);
  if (data.buckets.length === 0 || !hasData) return <WidgetEmpty />;

  const legendLabel = t(legendKey);
  const groups: BarGroup[] = data.buckets.map((b) => ({
    label: bucketLabel(b.date, config.period),
    values: [b.avgDays ?? 0],
  }));

  const maxY = Math.max(1, data.windowAverage ?? 0, ...data.buckets.map((b) => b.avgDays ?? 0));
  const yTickValues = niceTicks(maxY, 4);
  const yTicks = yTickValues.map((v) => ({ value: v, label: String(v) }));

  const referenceLine =
    data.windowAverage !== null
      ? {
          value: data.windowAverage,
          color: chartColor.average,
          label: t('barWindowAvg', { days: Math.round(data.windowAverage) }),
          legendLabel: t('barWindowAvg', { days: Math.round(data.windowAverage) }),
          dashed: true,
        }
      : undefined;

  return (
    <div className="px-3.5 py-4">
      <BarChart
        series={[{ label: legendLabel, color: barColor }]}
        groups={groups}
        yTicks={yTicks}
        yTitle={t('barYDays')}
        xTitle={t(UNIT_KEY[config.period])}
        referenceLine={referenceLine}
        valueFormat={(_value, gi) => {
          const avg = data.buckets[gi]?.avgDays;
          return avg === null || avg === undefined ? '—' : String(avg);
        }}
        maxXTicks={5}
        width={width}
        height={height}
        description={t(descKey, { period: t(UNIT_KEY[config.period]), days: data.daysBack })}
      />
    </div>
  );
}
