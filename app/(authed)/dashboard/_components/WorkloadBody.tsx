'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { HBarChart, type HBarDatum } from '@/components/ui/charts/HBarChart';
import { chartCategorical, chartColor } from '@/components/ui/charts/tokens';
import type { DataTableRow } from '@/components/ui/charts/ChartDataTable';
import type { DashboardWidgetSourceDto } from '@/lib/dto/dashboards';
import type { WorkloadConfig } from '@/lib/dashboards/widgetRegistry';
import type { WorkloadAssigneeDto, WorkloadDto } from '@/lib/dto/reports';
import { sourceParams, useWidgetData } from './useWidgetData';
import {
  WidgetEmpty,
  WidgetError,
  WidgetLoading,
  WidgetNoAccess,
  WidgetStale,
} from './WidgetStateView';

// The workload widget body (8.8.13 · rendererKind `hbar`): the 8.8.13
// horizontal ranked HBarChart over the workload read — open work per assignee,
// already sorted descending by the active measure with the unassigned bucket
// last (so the row order IS the DTO order). The Measure toggle picks `points`
// vs `count` per row; the unassigned ("None") bucket takes the neutral grey
// (`chartColor.categoricalNone`), every other row cycles the categorical ramp.

export function WorkloadBody({
  source,
  config,
  onReconfigure,
}: {
  source: DashboardWidgetSourceDto;
  config: WorkloadConfig;
  onReconfigure?: () => void;
}) {
  const t = useTranslations('dashboards');
  const tStat = useTranslations('dashboards.statistic');

  const search = useMemo(() => {
    const params = sourceParams(source);
    if (!params) return null;
    params.set('measure', config.measure);
    return params.toString();
  }, [source, config.measure]);

  const { state, reload } = useWidgetData<WorkloadDto>('/api/reports/workload', search);

  if (source.kind === 'stale') return <WidgetStale onReconfigure={onReconfigure} />;
  if (state.phase === 'loading') return <WidgetLoading shape="chart" />;
  if (state.phase === 'error') return <WidgetError onRetry={reload} />;
  if (state.result.state === 'no_access') return <WidgetNoAccess />;
  if (state.result.state === 'stale') return <WidgetStale onReconfigure={onReconfigure} />;

  const data = state.result.data;
  if (data.assignees.length === 0) return <WidgetEmpty />;

  const isPoints = config.measure === 'story_points';
  const rowValue = (a: WorkloadAssigneeDto) => (isPoints ? a.points : a.count);
  const rowLabel = (a: WorkloadAssigneeDto) => a.name ?? t('unassigned');
  const xTitle = isPoints ? t('hbarXPoints') : t('hbarXCount');

  let catIndex = 0;
  const bars: HBarDatum[] = data.assignees.map((a) => {
    const isNone = a.assigneeId === null;
    const color = isNone
      ? chartColor.categoricalNone
      : chartCategorical[catIndex++ % chartCategorical.length]!;
    return {
      label: rowLabel(a),
      value: rowValue(a),
      color,
    };
  });

  const tableRows: DataTableRow[] = data.assignees.map((a) => ({
    header: rowLabel(a),
    cells: [{ value: rowValue(a), numeric: true }],
  }));

  return (
    <div className="px-3.5 py-4">
      <HBarChart
        bars={bars}
        xTitle={xTitle}
        description={t('hbarDesc')}
        legend={[
          { label: t('hbarLegend'), color: chartCategorical[0]!, kind: 'swatch', emphasis: true },
        ]}
        dataTable={{
          caption: t('hbarDesc'),
          columns: [tStat('assignee'), xTitle],
          rows: tableRows,
        }}
      />
    </div>
  );
}
