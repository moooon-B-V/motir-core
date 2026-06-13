'use client';

import { useMemo } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useTranslations, useFormatter } from 'next-intl';
import { Minus, Plus } from 'lucide-react';
import {
  DifferenceAreaChart,
  chartColor,
  type ChartAxis,
  type ChartLegendItem,
} from '@/components/ui/charts';
import type { CreatedVsResolvedDto, ReportStaleReasonDto } from '@/lib/dto/reports';
import type { ReportPeriod } from '@/lib/reports/buckets';
import { differenceSeries, pickTickIndices } from '@/lib/reports/reportChartData';
import {
  buildReportHref,
  clampDaysBack,
  stepDaysBack,
  daysBackLadder,
  PERIOD_LABEL_KEY,
  PERIOD_AXIS_KEY,
} from '@/lib/reports/reportPageView';
import { Segmented } from '@/components/ui/Segmented';
import { ReportScopeCombobox, type ReportScopeOption } from './ReportScopeCombobox';
import { ReportStateMessage } from './ReportStateMessage';

// The Created-vs-Resolved report page body (Story 6.3 · Subtask 6.3.6), per
// design/reports/dashboard.mock.html panel 7. Owns the URL-driven controls
// (scope · period · days-back · cumulative) — each change NAVIGATES (the config
// round-trips through the URL, so a report is shareable; the Server Component
// re-reads and re-renders the chart). The chart is the 6.3.4 difference/area
// form bound to the 6.3.2 read; the difference fill (red where the backlog
// grows, green where the team catches up) + the visible legend + the data-table
// fallback carry the signal as text, never colour alone (finding #35).

export type CreatedVsResolvedResult =
  | { state: 'ok'; data: CreatedVsResolvedDto }
  | { state: 'no_access' }
  | { state: 'stale'; reason: ReportStaleReasonDto };

export function CreatedVsResolvedReport({
  result,
  period,
  daysBack,
  cumulative,
  savedFilterId,
  projectName,
  savedFilters,
}: {
  result: CreatedVsResolvedResult;
  period: ReportPeriod;
  daysBack: number;
  cumulative: boolean;
  savedFilterId: string | null;
  projectName: string;
  savedFilters: ReportScopeOption[];
}) {
  const t = useTranslations('reports');
  const fmt = useFormatter();
  const router = useRouter();
  const pathname = usePathname();

  function go(next: {
    savedFilterId?: string | null;
    period?: ReportPeriod;
    daysBack?: number;
    cumulative?: boolean;
  }) {
    const params = { savedFilterId, period, daysBack, cumulative, ...next };
    router.push(buildReportHref(pathname, params));
  }

  const ladder = daysBackLadder(period);
  const atMin = daysBack <= ladder[0]!;
  const atMax = daysBack >= ladder[ladder.length - 1]!;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <Field label={t('scope.label')}>
          <ReportScopeCombobox
            projectName={projectName}
            savedFilters={savedFilters}
            savedFilterId={savedFilterId}
            onChange={(id) => go({ savedFilterId: id })}
          />
        </Field>
        <Field label={t('cvr.periodLabel')}>
          <Segmented
            label={t('cvr.periodLabel')}
            value={period}
            onChange={(p) => go({ period: p, daysBack: clampDaysBack(p, daysBack) })}
            options={(['day', 'week', 'month'] as const).map((p) => ({
              value: p,
              label: t(PERIOD_LABEL_KEY[p]),
            }))}
          />
        </Field>
        <Field label={t('cvr.daysBackLabel')}>
          <div className="inline-flex items-center gap-1 rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) p-0.5">
            <button
              type="button"
              aria-label={t('cvr.daysBackFewer')}
              disabled={atMin}
              onClick={() => go({ daysBack: stepDaysBack(period, daysBack, -1) })}
              className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:text-(--el-text) disabled:opacity-40 disabled:hover:text-(--el-text-secondary) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <Minus className="h-4 w-4" aria-hidden />
            </button>
            <span
              className="min-w-12 text-center text-[13px] font-medium text-(--el-text)"
              aria-live="polite"
            >
              {t('cvr.daysBackValue', { days: daysBack })}
            </span>
            <button
              type="button"
              aria-label={t('cvr.daysBackMore')}
              disabled={atMax}
              onClick={() => go({ daysBack: stepDaysBack(period, daysBack, 1) })}
              className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:text-(--el-text) disabled:opacity-40 disabled:hover:text-(--el-text-secondary) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </Field>
        <Field label={t('cvr.aggregationLabel')}>
          {/* The mock draws a switch; Motir ships no Switch primitive, so the
              binary choice reuses the shipped Segmented (reuse over hand-rolling
              a primitive — the design-reference rule). */}
          <Segmented
            label={t('cvr.aggregationLabel')}
            value={cumulative ? 'cumulative' : 'per_period'}
            onChange={(v) => go({ cumulative: v === 'cumulative' })}
            options={[
              { value: 'per_period', label: t('cvr.perPeriod') },
              { value: 'cumulative', label: t('cvr.cumulative') },
            ]}
          />
        </Field>
      </div>

      <CreatedVsResolvedBody
        result={result}
        period={period}
        cumulative={cumulative}
        onReset={() => go({ savedFilterId: null })}
        t={t}
        fmt={fmt}
      />
    </div>
  );
}

function CreatedVsResolvedBody({
  result,
  period,
  cumulative,
  onReset,
  t,
  fmt,
}: {
  result: CreatedVsResolvedResult;
  period: ReportPeriod;
  cumulative: boolean;
  onReset: () => void;
  t: ReturnType<typeof useTranslations>;
  fmt: ReturnType<typeof useFormatter>;
}) {
  const series = useMemo(
    () => (result.state === 'ok' ? differenceSeries(result.data) : null),
    [result],
  );

  if (result.state === 'no_access') return <ReportStateMessage state={{ kind: 'no_access' }} />;
  if (result.state === 'stale') {
    return (
      <ReportStateMessage state={{ kind: 'stale', reason: result.reason }} onReset={onReset} />
    );
  }
  if (!series || (series.createdTotal === 0 && series.resolvedTotal === 0)) {
    return <ReportStateMessage state={{ kind: 'empty' }} />;
  }

  const periodNoun = t(PERIOD_LABEL_KEY[period]).toLocaleLowerCase();
  const labelForDate = (iso: string): string => {
    const d = new Date(iso);
    return period === 'month'
      ? fmt.dateTime(d, { month: 'short', year: '2-digit', timeZone: 'UTC' })
      : fmt.dateTime(d, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };

  const n = series.bucketDates.length;
  const x: ChartAxis = {
    domain: [0, Math.max(1, n - 1)],
    ticks: pickTickIndices(n).map((i) => ({
      value: i,
      label: labelForDate(series.bucketDates[i]!),
    })),
    title: t(PERIOD_AXIS_KEY[period]),
  };
  const y: ChartAxis = {
    domain: [0, series.yMax],
    ticks: series.yTicks.map((v) => ({ value: v, label: String(v) })),
    title: t('cvr.yItems'),
  };

  const createdLabel = t('cvr.created');
  const resolvedLabel = t('cvr.resolved');
  const legend: ChartLegendItem[] = [
    {
      label: t('cvr.legendCreated', { total: series.createdTotal }),
      color: chartColor.created,
      kind: 'line',
      emphasis: true,
    },
    {
      label: t('cvr.legendResolved', { total: series.resolvedTotal }),
      color: chartColor.resolved,
      kind: 'line',
      emphasis: true,
    },
    { label: t('cvr.legendBacklog'), color: chartColor.deficit, kind: 'swatch' },
    { label: t('cvr.legendCatchingUp'), color: chartColor.surplus, kind: 'swatch' },
  ];

  const formatNet = (net: number): string =>
    net > 0 ? `+${net}` : net < 0 ? `−${Math.abs(net)}` : '0';

  return (
    <DifferenceAreaChart
      created={series.created}
      resolved={series.resolved}
      x={x}
      y={y}
      width={680}
      height={320}
      createdLabel={createdLabel}
      resolvedLabel={resolvedLabel}
      legend={legend}
      ariaLabel={t('cvr.title')}
      description={t('cvr.chartDesc', {
        period: periodNoun,
        count: n,
        created: series.createdTotal,
        resolved: series.resolvedTotal,
      })}
      dataTable={{
        caption: cumulative ? t('cvr.tableCaptionCumulative') : t('cvr.tableCaption'),
        columns: [t(PERIOD_AXIS_KEY[period]), createdLabel, resolvedLabel, t('cvr.net')],
        rows: series.bucketDates.map((iso, i) => ({
          header: labelForDate(iso),
          cells: [
            { value: series.created[i]!.y, numeric: true },
            { value: series.resolved[i]!.y, numeric: true },
            { value: formatNet(series.nets[i]!), numeric: true },
          ],
        })),
      }}
    />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-(--el-text-muted)">{label}</span>
      {children}
    </div>
  );
}
