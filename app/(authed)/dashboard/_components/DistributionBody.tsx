'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { DonutChart, type DonutDatum } from '@/components/ui/charts/DonutChart';
import type { DashboardWidgetSourceDto } from '@/lib/dto/dashboards';
import type { DistributionConfig } from '@/lib/dashboards/widgetRegistry';
import type { DistributionDto, DistributionSegmentDto } from '@/lib/dto/reports';
import { statisticLabel } from './widgetMeta';
import { sourceParams, useWidgetData } from './useWidgetData';
import {
  WidgetEmpty,
  WidgetError,
  WidgetLoading,
  WidgetNoAccess,
  WidgetStale,
} from './WidgetStateView';

// The distribution widget body (6.3.5 · rendererKind `donut`): the 6.3.4 donut
// over the 6.3.2 group-by read. The self-describing enum ids (kind / priority)
// carry a null label the UI translates; named referents (status / assignee /
// sprint / label / component / CF) come back labelled; a null id is the None
// segment.

export function DistributionBody({
  source,
  config,
  customFieldNames,
  onReconfigure,
  legendLayout = 'side',
}: {
  source: DashboardWidgetSourceDto;
  config: DistributionConfig;
  customFieldNames?: Record<string, string>;
  onReconfigure?: () => void;
  legendLayout?: 'side' | 'below';
}) {
  const t = useTranslations('dashboards');
  const tIssueType = useTranslations('labels.issueType');
  const tPriority = useTranslations('labels.priority');

  const search = useMemo(() => {
    const params = sourceParams(source);
    if (!params) return null;
    params.set('statistic', config.statisticType);
    return params.toString();
  }, [source, config.statisticType]);

  const { state, reload } = useWidgetData<DistributionDto>('/api/reports/distribution', search);

  const statLabel = statisticLabel(config.statisticType, t, customFieldNames);

  const segLabel = (seg: DistributionSegmentDto): string => {
    if (seg.id === null) return t('none');
    if (seg.label) return seg.label;
    if (config.statisticType === 'kind') return tIssueType(seg.id);
    if (config.statisticType === 'priority') return tPriority(seg.id);
    return seg.id;
  };

  if (source.kind === 'stale') return <WidgetStale onReconfigure={onReconfigure} />;
  if (state.phase === 'loading') return <WidgetLoading shape="chart" />;
  if (state.phase === 'error') return <WidgetError onRetry={reload} />;
  if (state.result.state === 'no_access') return <WidgetNoAccess />;
  if (state.result.state === 'stale') return <WidgetStale onReconfigure={onReconfigure} />;

  const data = state.result.data;
  if (data.total === 0 || data.segments.length === 0) return <WidgetEmpty />;

  const donutData: DonutDatum[] = data.segments.map((seg) => ({
    label: segLabel(seg),
    value: seg.count,
    none: seg.id === null,
  }));

  return (
    <div className="px-3.5 py-4">
      <DonutChart
        data={donutData}
        legendLayout={legendLayout}
        totalNoun={t('totalNoun')}
        statisticLabel={statLabel}
        description={t('donutDesc', { total: data.total, statistic: statLabel })}
        emptyState={<p>{t('donutEmpty')}</p>}
      />
    </div>
  );
}
