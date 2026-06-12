'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CircleDot } from 'lucide-react';
import { DonutChart, type DonutDatum } from '@/components/ui/charts';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import type {
  DistributionDto,
  DistributionSegmentDto,
  ReportStaleReasonDto,
} from '@/lib/dto/reports';
import { buildReportHref } from '@/lib/reports/reportPageView';
import { ReportScopeCombobox, type ReportScopeOption } from './ReportScopeCombobox';
import { ReportStateMessage } from './ReportStateMessage';

// The Status-distribution report page body (Story 6.3 · Subtask 6.3.6), per
// design/reports/dashboard.mock.html panel 7. Owns the URL-driven scope +
// statistic-type controls (the verified Jira Pie-Chart config); each change
// navigates so the report is shareable. The chart is the 6.3.4 donut bound to
// the 6.3.2 group-by read; counts + percentages live in the visible legend and
// the data-table fallback, so the breakdown reads as text, never colour alone
// (finding #35).

/** A statistic-type option for the picker (`status`, `assignee`, … or
 * `cf:<id>`), with its display label + group (built-in vs custom field). */
export interface StatisticOption {
  value: string;
  label: string;
  group: string;
}

export type DistributionResult =
  | { state: 'ok'; data: DistributionDto }
  | { state: 'no_access' }
  | { state: 'stale'; reason: ReportStaleReasonDto };

export function DistributionReport({
  result,
  statistic,
  statisticLabel,
  statisticOptions,
  savedFilterId,
  projectName,
  savedFilters,
}: {
  result: DistributionResult;
  statistic: string;
  /** The current statistic's display label (the chart legend/table heading). */
  statisticLabel: string;
  statisticOptions: StatisticOption[];
  savedFilterId: string | null;
  projectName: string;
  savedFilters: ReportScopeOption[];
}) {
  const t = useTranslations('reports');
  const tLabels = useTranslations('labels');
  const router = useRouter();
  const pathname = usePathname();

  function go(next: { savedFilterId?: string | null; statistic?: string }) {
    router.push(buildReportHref(pathname, { savedFilterId, statistic, ...next }));
  }

  const statOptions: ComboboxOption<string>[] = statisticOptions.map((o) => ({
    value: o.value,
    label: o.label,
    group: o.group,
    icon: <CircleDot className="h-4 w-4" aria-hidden />,
  }));

  /** Resolve a segment's display label: the referent name where the read has
   * one; the translated enum name for the self-describing `kind` / `priority`
   * statistics (label null by design); the designed "None" for the null group. */
  const labelForSegment = (seg: DistributionSegmentDto): string => {
    if (seg.id === null) return t('states.none');
    if (seg.label !== null) return seg.label;
    if (statistic === 'kind') return tLabels(`issueType.${seg.id}`);
    if (statistic === 'priority') return tLabels(`priority.${seg.id}`);
    return seg.id;
  };

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
        <Field label={t('distribution.statisticLabel')}>
          <Combobox
            label={t('distribution.statisticLabel')}
            options={statOptions}
            value={statistic}
            onChange={(v) => go({ statistic: v })}
            searchable={statOptions.length > 6}
            searchPlaceholder={t('distribution.statisticSearch')}
          />
        </Field>
      </div>

      <DistributionBody
        result={result}
        statisticLabel={statisticLabel}
        labelForSegment={labelForSegment}
        onReset={() => go({ savedFilterId: null })}
        t={t}
      />
    </div>
  );
}

function DistributionBody({
  result,
  statisticLabel,
  labelForSegment,
  onReset,
  t,
}: {
  result: DistributionResult;
  statisticLabel: string;
  labelForSegment: (seg: DistributionSegmentDto) => string;
  onReset: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  if (result.state === 'no_access') return <ReportStateMessage state={{ kind: 'no_access' }} />;
  if (result.state === 'stale') {
    return (
      <ReportStateMessage state={{ kind: 'stale', reason: result.reason }} onReset={onReset} />
    );
  }
  if (result.data.total === 0) return <ReportStateMessage state={{ kind: 'empty' }} />;

  const data: DonutDatum[] = result.data.segments.map((seg) => ({
    label: labelForSegment(seg),
    value: seg.count,
    isNone: seg.id === null,
  }));

  const description = t('distribution.chartDesc', {
    total: result.data.total,
    statistic: statisticLabel.toLocaleLowerCase(),
    breakdown: result.data.segments
      .map((seg) => `${labelForSegment(seg)} ${seg.count} (${seg.percentage}%)`)
      .join(', '),
  });

  return (
    <div className="flex justify-center py-2">
      <DonutChart
        data={data}
        description={description}
        ariaLabel={t('distribution.title')}
        totalNoun={t('distribution.issues')}
        statisticLabel={statisticLabel}
        // Page-level size: the `below` layout renders the donut at the full
        // `size`, so 360 → a ~300 px ring — a primary page visualization, not
        // the ~170 px widget-tile thumbnail this page used to inherit
        // (bug-reports-chart-sizing).
        size={360}
        legendLayout="below"
      />
    </div>
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
