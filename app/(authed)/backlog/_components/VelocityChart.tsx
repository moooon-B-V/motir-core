'use client';

import { BarChart3 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { BarChart, chartColor, niceTicks } from '@/components/ui/charts';
import type { EstimationStatisticDto } from '@/lib/dto/estimation';
import type { VelocityDto } from '@/lib/dto/reports';

// The sprint-report VELOCITY chart (Story 4.6 · Subtask 4.6.6) — binds the
// 4.6.2 grouped `BarChart` primitive to the 4.6.4 `getVelocity` data, per
// design/reports/charts.mock.html panel 3 (the chart) + panel 5 (the
// sprint-report seam placement). PURE presentational: the host fetches the
// `VelocityDto` (the standalone report page reads `reportsService.getVelocity`
// server-side) and this renders it — committed (the locked 4.4.2 baseline) vs
// completed (the 4.3.3 done-category roll-up) per completed sprint, oldest →
// newest, plus the dashed average-completed reference (the planning forecast).
//
// Low history (0–1 completed sprints) renders the "not enough history yet"
// state from panel 4 — never an axis-of-one (the DTO stays total; the UI owns
// the empty-state copy). Unestimated sprints arrive as 0s, never `NaN`.
// Colour via the `--el-chart-*` tokens (the `chartColor` map), shape via
// element-semantic tokens; the bars are distinguished by the TEXT legend +
// value labels + the data-table fallback, never colour alone (finding #35).

/** Velocity needs ≥2 completed sprints to show a trend (panel 4). */
const MIN_SPRINTS_FOR_TREND = 2;

const STATISTIC_LABEL_KEY: Record<EstimationStatisticDto, string> = {
  story_points: 'statisticStoryPoints',
  time_estimate: 'statisticTime',
  issue_count: 'statisticIssueCount',
};

export function VelocityChart({ velocity }: { velocity: VelocityDto }) {
  const t = useTranslations('backlog');
  const tStat = useTranslations('settings.estimation');

  if (velocity.sprints.length < MIN_SPRINTS_FOR_TREND) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 rounded-(--radius-card) border border-dashed border-(--el-border-strong) px-(--spacing-card-padding) py-6 text-center">
        <BarChart3 className="h-6 w-6 text-(--el-text-faint)" aria-hidden />
        <span className="text-sm text-(--el-text-muted)">
          {t('sprintReport.velocityLowHistoryTitle')}
        </span>
        <span className="text-xs text-(--el-text-faint)">
          {t('sprintReport.velocityLowHistoryBody')}
        </span>
      </div>
    );
  }

  const average = Number(velocity.averageCompleted.toFixed(1));
  const committedLabel = t('sprintReport.velocityCommitted');
  const completedLabel = t('sprintReport.velocityCompleted');
  const statisticLabel = tStat(STATISTIC_LABEL_KEY[velocity.statistic]);

  const dataMax = Math.max(average, ...velocity.sprints.flatMap((s) => [s.committed, s.completed]));
  const yTicks = niceTicks(dataMax).map((value) => ({ value, label: String(value) }));

  const description = [
    t('sprintReport.velocityDesc', { count: velocity.sprints.length, average }),
    ...velocity.sprints.map((s) =>
      t('sprintReport.velocityDescSprint', {
        name: s.name,
        committed: s.committed,
        completed: s.completed,
      }),
    ),
  ].join(' ');

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-(--el-text-muted)">
        {t('sprintReport.velocityWindow', { count: velocity.sprints.length })}
        {' · '}
        {t('sprintReport.velocityAverage', { average })}
      </span>
      <BarChart
        series={[
          { label: committedLabel, color: chartColor.committed },
          { label: completedLabel, color: chartColor.completed },
        ]}
        groups={velocity.sprints.map((s) => ({
          label: s.name,
          values: [s.committed, s.completed],
        }))}
        yTicks={yTicks}
        yTitle={statisticLabel}
        xTitle={t('sprintReport.velocityXTitle')}
        description={description}
        ariaLabel={t('sprintReport.velocity')}
        referenceLine={{
          value: average,
          color: chartColor.average,
          label: t('sprintReport.velocityAvgAnnotation', { average }),
          legendLabel: t('sprintReport.velocityAverageLegend'),
        }}
        dataTable={{
          caption: t('sprintReport.velocityTableCaption', {
            statistic: statisticLabel.toLocaleLowerCase(),
            average,
          }),
          columns: [t('sprintReport.velocityTableSprint'), committedLabel, completedLabel],
          rows: velocity.sprints.map((s) => ({
            header: s.name,
            cells: [
              { value: s.committed, numeric: true },
              { value: s.completed, numeric: true },
            ],
          })),
        }}
      />
    </div>
  );
}
