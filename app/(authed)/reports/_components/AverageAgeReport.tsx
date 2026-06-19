'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Minus, Plus } from 'lucide-react';
import { BarChart, chartColor, niceTicks, type ChartLegendItem } from '@/components/ui/charts';
import type { AverageAgeDto, ReportPeriodDto, ReportStaleReasonDto } from '@/lib/dto/reports';
import {
  buildReportHref,
  clampDaysBack,
  stepDaysBack,
  daysBackLadder,
  PERIOD_LABEL_KEY,
} from '@/lib/reports/reportPageView';
import { Segmented } from '@/components/ui/Segmented';
import { ReportScopeCombobox, type ReportScopeOption } from './ReportScopeCombobox';
import { ReportStateMessage } from './ReportStateMessage';

// The Average-age report page body (Story 8.8 · Subtask 8.8.13), per
// design/reports/more-reports.mock.html panel 2. Owns the URL-driven controls
// (scope · period · days-back) — each change NAVIGATES (the config round-trips
// through the URL, so the report is shareable; the Server Component re-reads and
// re-renders). The chart is the 4.6.2 vertical BarChart: one bar per period of
// the average DAYS unresolved issues have aged, with a dashed window-average
// reference line. An event-less bucket renders "—", never a misleading 0 (the
// 4.5.2 rule); the legend + the data-table carry the signal as text, never
// colour alone (finding #35).

export type AverageAgeResult =
  | { state: 'ok'; data: AverageAgeDto }
  | { state: 'no_access' }
  | { state: 'stale'; reason: ReportStaleReasonDto };

/** Bucket-axis label — copied from the dashboard CreatedVsResolvedBody so the
 * two surfaces format a period bucket identically (UTC `date_trunc` semantics). */
function bucketLabel(dateIso: string, period: ReportPeriodDto): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const opts: Intl.DateTimeFormatOptions =
    period === 'month'
      ? { month: 'short', year: '2-digit', timeZone: 'UTC' }
      : { month: 'short', day: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat('en-US', opts).format(d);
}

export function AverageAgeReport({
  result,
  period,
  daysBack,
  savedFilterId,
  projectName,
  savedFilters,
}: {
  result: AverageAgeResult;
  period: ReportPeriodDto;
  daysBack: number;
  savedFilterId: string | null;
  projectName: string;
  savedFilters: ReportScopeOption[];
}) {
  const t = useTranslations('reports');
  const router = useRouter();
  const pathname = usePathname();

  function go(next: {
    savedFilterId?: string | null;
    period?: ReportPeriodDto;
    daysBack?: number;
  }) {
    router.push(buildReportHref(pathname, { savedFilterId, period, daysBack, ...next }));
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
        <Field label={t('controls.periodLabel')}>
          <Segmented
            label={t('controls.periodLabel')}
            value={period}
            onChange={(p) => go({ period: p, daysBack: clampDaysBack(p, daysBack) })}
            options={(['day', 'week', 'month'] as const).map((p) => ({
              value: p,
              label: t(PERIOD_LABEL_KEY[p]),
            }))}
          />
        </Field>
        <Field label={t('controls.daysBackLabel')}>
          <div className="inline-flex items-center gap-1 rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) p-0.5">
            <button
              type="button"
              aria-label={t('controls.daysBackFewer')}
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
              aria-label={t('controls.daysBackMore')}
              disabled={atMax}
              onClick={() => go({ daysBack: stepDaysBack(period, daysBack, 1) })}
              className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:text-(--el-text) disabled:opacity-40 disabled:hover:text-(--el-text-secondary) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </Field>
      </div>

      <AverageAgeBody
        result={result}
        period={period}
        onReset={() => go({ savedFilterId: null })}
        t={t}
      />
    </div>
  );
}

function AverageAgeBody({
  result,
  period,
  onReset,
  t,
}: {
  result: AverageAgeResult;
  period: ReportPeriodDto;
  onReset: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  if (result.state === 'no_access') return <ReportStateMessage state={{ kind: 'no_access' }} />;
  if (result.state === 'stale') {
    return (
      <ReportStateMessage state={{ kind: 'stale', reason: result.reason }} onReset={onReset} />
    );
  }

  const { buckets, windowAverage } = result.data;
  // Empty = no bucket carries an average (every bucket event-less, or none).
  if (buckets.length === 0 || buckets.every((b) => b.avgDays === null)) {
    return <ReportStateMessage state={{ kind: 'empty' }} />;
  }

  const maxAvg = Math.max(0, ...buckets.map((b) => b.avgDays ?? 0));
  const yTicks = niceTicks(maxAvg).map((v) => ({ value: v, label: String(v) }));

  const noValue = t('averageAge.noValue');
  const legend: ChartLegendItem[] = [
    {
      label: `${t('averageAge.legendLabel')} · ${t('averageAge.legendUnit')}`,
      color: chartColor.age,
      kind: 'swatch',
      emphasis: true,
    },
  ];
  if (windowAverage !== null) {
    legend.push({
      label: t('averageAge.windowAverage', { days: windowAverage }),
      color: chartColor.average,
      kind: 'dash',
    });
  }

  return (
    <BarChart
      series={[{ label: t('averageAge.legendLabel'), color: chartColor.age }]}
      groups={buckets.map((b) => ({
        label: bucketLabel(b.date, period),
        values: [b.avgDays ?? 0],
      }))}
      yTicks={yTicks}
      yTitle={t('averageAge.yDays')}
      xTitle={t('averageAge.xAxis')}
      referenceLine={
        windowAverage !== null
          ? {
              value: windowAverage,
              color: chartColor.average,
              dashed: true,
              legendLabel: t('averageAge.windowAverage', { days: windowAverage }),
            }
          : undefined
      }
      valueFormat={(_v, gi) =>
        buckets[gi]!.avgDays === null ? noValue : String(buckets[gi]!.avgDays)
      }
      legend={legend}
      width={680}
      height={320}
      ariaLabel={t('averageAge.title')}
      description={t('averageAge.chartDesc', {
        period: t(PERIOD_LABEL_KEY[period]).toLocaleLowerCase(),
        count: buckets.length,
        average: windowAverage ?? noValue,
      })}
      dataTable={{
        caption: t('averageAge.tableCaption'),
        columns: [
          t('averageAge.tablePeriod'),
          t('averageAge.tableCount'),
          t('averageAge.tableAvg'),
        ],
        rows: buckets.map((b) => ({
          header: bucketLabel(b.date, period),
          cells: [
            { value: b.count, numeric: true },
            { value: b.avgDays === null ? noValue : b.avgDays, numeric: true },
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
