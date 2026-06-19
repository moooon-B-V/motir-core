'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  HBarChart,
  chartColor,
  chartCategorical,
  type ChartLegendItem,
} from '@/components/ui/charts';
import type { WorkloadDto, WorkloadMeasureDto, ReportStaleReasonDto } from '@/lib/dto/reports';
import { buildReportHref } from '@/lib/reports/reportPageView';
import { Segmented } from '@/components/ui/Segmented';
import { ReportScopeCombobox, type ReportScopeOption } from './ReportScopeCombobox';
import { ReportStateMessage } from './ReportStateMessage';

// The Workload report page body (Story 8.8 · Subtask 8.8.13), per
// design/reports/more-reports.mock.html panel 4. Owns the URL-driven scope +
// MEASURE controls (story points vs work-item count); each change navigates so
// the report is shareable. The chart is the 8.8.13 horizontal ranked HBarChart —
// open work per assignee, the unassigned bucket last (the justified deviation
// from Jira's pie: a magnitude ranking reads directly as bar length, no
// segment-overflow cliff). The Measure toggle is a client-driven re-rank of the
// same DTO (both points + count travel). Each bar is named + valued + in the
// data table, never colour alone (finding #35).

export type WorkloadResult =
  | { state: 'ok'; data: WorkloadDto }
  | { state: 'no_access' }
  | { state: 'stale'; reason: ReportStaleReasonDto };

export function WorkloadReport({
  result,
  measure,
  savedFilterId,
  projectName,
  savedFilters,
}: {
  result: WorkloadResult;
  measure: WorkloadMeasureDto;
  savedFilterId: string | null;
  projectName: string;
  savedFilters: ReportScopeOption[];
}) {
  const t = useTranslations('reports');
  const router = useRouter();
  const pathname = usePathname();

  function go(next: { savedFilterId?: string | null; measure?: WorkloadMeasureDto }) {
    router.push(buildReportHref(pathname, { savedFilterId, measure, ...next }));
  }

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
        <Field label={t('controls.measureLabel')}>
          <Segmented
            label={t('controls.measureLabel')}
            value={measure}
            onChange={(m) => go({ measure: m })}
            options={[
              { value: 'story_points', label: t('controls.storyPoints') },
              { value: 'issue_count', label: t('controls.issueCount') },
            ]}
          />
        </Field>
      </div>

      <WorkloadBody
        result={result}
        measure={measure}
        onReset={() => go({ savedFilterId: null })}
        t={t}
      />
    </div>
  );
}

function WorkloadBody({
  result,
  measure,
  onReset,
  t,
}: {
  result: WorkloadResult;
  measure: WorkloadMeasureDto;
  onReset: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  if (result.state === 'no_access') return <ReportStateMessage state={{ kind: 'no_access' }} />;
  if (result.state === 'stale') {
    return (
      <ReportStateMessage state={{ kind: 'stale', reason: result.reason }} onReset={onReset} />
    );
  }

  const { assignees, totalPoints, totalCount } = result.data;
  if (assignees.length === 0) return <ReportStateMessage state={{ kind: 'empty' }} />;

  const isCount = measure === 'issue_count';
  const valueOf = (a: (typeof assignees)[number]) => (isCount ? a.count : a.points);

  const bars = assignees.map((a, i) => ({
    label: a.name ?? t('workload.unassigned'),
    value: valueOf(a),
    color:
      a.assigneeId === null
        ? chartColor.categoricalNone
        : chartCategorical[i % chartCategorical.length]!,
    valueLabel: String(valueOf(a)),
  }));

  const legend: ChartLegendItem[] = [
    {
      label: `${t('workload.legendLabel')} · ${
        isCount ? t('workload.legendUnitCount') : t('workload.legendUnitPoints')
      }`,
      color: chartColor.categoricalNone,
      kind: 'swatch',
      emphasis: true,
    },
  ];

  return (
    <HBarChart
      bars={bars}
      xTitle={isCount ? t('workload.xCount') : t('workload.xPoints')}
      width={680}
      legend={legend}
      ariaLabel={t('workload.title')}
      description={t('workload.chartDesc', {
        measure: isCount ? t('workload.legendUnitCount') : t('workload.legendUnitPoints'),
        breakdown: assignees
          .map((a) => `${a.name ?? t('workload.unassigned')} ${valueOf(a)}`)
          .join(', '),
        total: isCount ? totalCount : totalPoints,
        count: totalCount,
      })}
      dataTable={{
        caption: t('workload.tableCaption'),
        columns: [
          t('workload.tableAssignee'),
          t('workload.tablePoints'),
          t('workload.tableIssues'),
        ],
        rows: assignees.map((a) => ({
          header: a.name ?? t('workload.unassigned'),
          cells: [
            { value: a.points, numeric: true },
            { value: a.count, numeric: true },
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
