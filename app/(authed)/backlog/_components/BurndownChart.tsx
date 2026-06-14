'use client';

import { useLocale, useTranslations } from 'next-intl';
import { LineChart, chartColor, niceTicks } from '@/components/ui/charts';
import type {
  AxisTick,
  ChartAnnotation,
  ChartLegendItem,
  DataTableRow,
  LineSeries,
  ReferenceLine,
} from '@/components/ui/charts';
import type { BurndownDayDto, BurndownSeriesDto } from '@/lib/dto/reports';

// The BURNDOWN chart (Story 4.6 · Subtask 4.6.5) — binds the 4.6.2 `LineChart`
// primitive to the 4.6.3 `getBurndownSeries` data, per
// design/reports/charts.mock.html panel 1 (the full report form) and panel 2
// (the compact scrum-header form). PURE presentational: the host fetches the
// `BurndownSeriesDto` and this renders it — the dashed GUIDELINE (the ideal
// straight descent from the committed baseline to 0) and the ACTUAL remaining
// (a STEP line that drops on done-category transitions and rises on mid-sprint
// scope adds), reconstructed upstream from the 1.4.6 revision trail.
//
//   • `full` (the sprint-report seam, panel 1) — axes + day ticks + legend,
//     the committed-baseline + end-point annotations, and the scope-change
//     diamonds with their "+N scope" labels.
//   • `compact` (the scrum-header slot, panels 2 + 5) — a smaller frame, the
//     Y axis topping at the committed baseline, the actual line drawn to
//     "today" (the dashed vertical marker), scope markers omitted for density,
//     and the legend hidden (the slot label + day sub-line carry the text;
//     the `<desc>` + data-table fallback still convey every series).
//
// Degraded states stay total (never `NaN` — panel 4): a wholly-unestimated
// sprint arrives as the `issue_count` series (the Y title flips to issues);
// an empty sprint (committed 0) draws the flat-at-0 guideline with the
// "nothing committed" note. Colour via the `--el-chart-*` tokens (the
// `chartColor` map), shape via element-semantic tokens; the series read as
// text+number via the legend + `<desc>` + data table (finding #35).

/** The index of the last day with an actual (non-null) remaining value — the
 *  burndown's cutoff: "today" for an active sprint, completion for a closed
 *  one. -1 when no actual value exists (a degenerate series). */
export function burndownCutoffIndex(days: BurndownDayDto[]): number {
  let cutoff = -1;
  for (let i = 0; i < days.length; i++) {
    if (days[i]?.remaining != null) cutoff = i;
  }
  return cutoff;
}

const STATISTIC_LABEL_KEY = {
  story_points: 'statisticStoryPoints',
  issue_count: 'statisticIssueCount',
} as const;

/** Month + day, no year — the chart-sub window form (`Jun 2 → Jun 14`, panel 1);
 *  the report's top meta line already carries the year-qualified window. */
function formatChartDay(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function BurndownChart({
  burndown,
  variant,
}: {
  burndown: BurndownSeriesDto;
  variant: 'full' | 'compact';
}) {
  const t = useTranslations('backlog');
  const tStat = useTranslations('settings.estimation');
  const locale = useLocale();

  const full = variant === 'full';
  const { days, committed, scopeChanges, state } = burndown;
  const lastDay = Math.max(days.length - 1, 1);
  const cutoff = burndownCutoffIndex(days);
  const endRemaining = cutoff >= 0 ? (days[cutoff]?.remaining ?? 0) : committed;
  const empty = committed === 0;

  const statisticLabel = tStat(STATISTIC_LABEL_KEY[burndown.statistic]);
  const guidelineLabel = t('sprintReport.burndownGuideline');
  const remainingLabel = t('sprintReport.burndownRemaining');

  // ── Axes ──────────────────────────────────────────────────────────────────
  const maxY = Math.max(
    committed,
    ...days.map((d) => d.guideline),
    ...days.map((d) => d.remaining ?? 0),
  );
  let yTickValues: number[];
  let yMax: number;
  if (empty) {
    // Empty sprint — the flat-at-0 guideline needs a non-degenerate domain.
    yTickValues = [0];
    yMax = 1;
  } else if (full) {
    yTickValues = niceTicks(maxY);
    yMax = Math.max(maxY, yTickValues[yTickValues.length - 1] ?? maxY);
  } else {
    // Compact: the Y axis tops at the committed baseline (panel 2) — nice
    // ticks below it plus the baseline itself as the top label.
    yTickValues = [...niceTicks(maxY).filter((v) => v <= maxY * 0.85), maxY];
    yMax = maxY;
  }
  const yTicks: AxisTick[] = yTickValues.map((value) => ({ value, label: String(value) }));

  // Full: every day (thinned past 12 to keep labels legible); compact: start /
  // today / end only (panel 2).
  const xStep = full ? Math.max(1, Math.ceil(days.length / 12)) : 1;
  const xTickValues = full
    ? Array.from(new Set([...days.map((_, i) => i).filter((i) => i % xStep === 0), lastDay]))
    : Array.from(new Set([0, ...(state === 'active' && cutoff > 0 ? [cutoff] : []), lastDay]));
  const xTicks: AxisTick[] = xTickValues
    .sort((a, b) => a - b)
    .map((value) => ({
      value,
      label: String(value),
    }));

  // ── Series ────────────────────────────────────────────────────────────────
  const series: LineSeries[] = [
    {
      id: 'guideline',
      label: guidelineLabel,
      points: days.map((d, i) => ({ x: i, y: d.guideline })),
      color: chartColor.guideline,
      interpolation: 'linear',
      dashed: true,
      strokeWidth: 2,
    },
    {
      id: 'actual',
      label: remainingLabel,
      // The actual line stops at the cutoff (nulls after it are future days).
      points: days.slice(0, cutoff + 1).map((d, i) => ({ x: i, y: d.remaining })),
      color: chartColor.actual,
      interpolation: 'step',
      strokeWidth: full ? 2.75 : 2.5,
      markers: 'endpoint',
    },
  ];

  // The "today" vertical marker — a LIVE sprint only (a completed sprint's
  // actual line simply ends at `completedAt`, panel 1 vs 2).
  const referenceLines: ReferenceLine[] =
    state === 'active' && cutoff >= 0
      ? [
          {
            orientation: 'vertical',
            value: cutoff,
            color: chartColor.axis,
            dashed: true,
            legendLabel: full ? t('sprintReport.burndownToday') : undefined,
          },
        ]
      : [];

  // ── Annotations (full form only — panel 1) ───────────────────────────────
  const annotations: ChartAnnotation[] = [];
  if (full && !empty) {
    annotations.push({
      x: 0,
      y: committed,
      color: chartColor.actual,
      label: t('sprintReport.burndownCommittedAnnotation', { committed }),
    });
    if (cutoff > 0) {
      annotations.push({
        x: cutoff,
        y: endRemaining,
        color: chartColor.actual,
        label: t('sprintReport.burndownEndAnnotation', { remaining: endRemaining }),
        labelAnchor: 'end',
        labelDy: 16,
      });
    }
    for (const sc of scopeChanges) {
      const dayIndex = days.findIndex((d) => d.date === sc.date);
      const at = days[dayIndex]?.remaining ?? null;
      if (dayIndex < 0 || at === null) continue;
      annotations.push({
        x: dayIndex,
        y: at,
        color: chartColor.scope,
        shape: 'diamond',
        label: t('sprintReport.burndownScopeAnnotation', { delta: signed(sc.delta) }),
      });
    }
  }

  // The derived legend covers the two series + the today rule; the scope
  // marker needs its own entry (panel 1's "Scope added").
  const legend: ChartLegendItem[] | undefined =
    full && scopeChanges.length > 0
      ? [
          { label: guidelineLabel, color: chartColor.guideline, kind: 'dash' },
          { label: remainingLabel, color: chartColor.actual, kind: 'line', emphasis: true },
          { label: t('sprintReport.burndownScopeAdded'), color: chartColor.scope, kind: 'swatch' },
          ...(state === 'active'
            ? [
                {
                  label: t('sprintReport.burndownToday'),
                  color: chartColor.axis,
                  kind: 'dash' as const,
                },
              ]
            : []),
        ]
      : undefined;

  // ── A11y — the `<desc>` summary + the data-table fallback (finding #35) ──
  const description = [
    state === 'active'
      ? t('sprintReport.burndownDescActive', {
          day: Math.max(cutoff, 0),
          total: lastDay,
          committed,
          remaining: endRemaining,
          statistic: statisticLabel,
        })
      : t('sprintReport.burndownDescComplete', {
          total: lastDay,
          committed,
          remaining: endRemaining,
          statistic: statisticLabel,
        }),
    ...scopeChanges.map((sc) =>
      t('sprintReport.burndownDescScope', {
        delta: signed(sc.delta),
        day: Math.max(
          days.findIndex((d) => d.date === sc.date),
          0,
        ),
      }),
    ),
  ].join(' ');

  const dayHeader = (i: number): string =>
    state === 'active' && i === cutoff
      ? t('sprintReport.burndownTableToday', { day: i })
      : String(i);
  const eventFor = (day: BurndownDayDto, i: number): string => {
    const sc = scopeChanges.find((c) => c.date === day.date);
    if (i === 0) return t('sprintReport.burndownEventStart', { committed });
    if (sc) return t('sprintReport.burndownEventScope', { delta: signed(sc.delta) });
    if (state === 'complete' && i === cutoff) return t('sprintReport.burndownEventCompleted');
    return '';
  };
  const rows: DataTableRow[] = days.map((d, i) => ({
    header: dayHeader(i),
    cells: [
      { value: d.guideline, numeric: true },
      { value: d.remaining ?? '—', numeric: true },
      ...(full ? [{ value: eventFor(d, i) }] : []),
    ],
  }));
  const dataTable = {
    caption: t('sprintReport.burndownTableCaption', { statistic: statisticLabel }),
    columns: [
      t('sprintReport.burndownTableDay'),
      guidelineLabel,
      remainingLabel,
      ...(full ? [t('sprintReport.burndownTableEvent')] : []),
    ],
    rows,
  };

  // The muted chart-sub line under the section title (panel 1 / design-notes:
  // "a serif title + a muted sub-line") — window · state · committed. The
  // VELOCITY chart renders its own (window · average); the burndown lacked it,
  // so the two side-by-side report charts started their plots at different
  // heights (bug-sprint-report-burndown-missing-chart-sub). Full form only —
  // the compact scrum-header slot carries its own "Sprint N · day X of Y" line.
  const subLine = [
    t('sprintReport.metaWindow', {
      start: formatChartDay(burndown.startDate, locale),
      end: formatChartDay(burndown.endDate, locale),
    }),
    t('sprintReport.burndownSubState', { state }),
    burndown.statistic === 'story_points'
      ? t('sprintReport.burndownSubPoints', { committed })
      : t('sprintReport.burndownSubIssues', { committed }),
  ].join(' · ');

  return (
    <div className={`flex flex-col ${full ? 'gap-2' : 'gap-1'}`}>
      {full ? <span className="text-xs text-(--el-text-muted)">{subLine}</span> : null}
      <LineChart
        series={series}
        x={{
          domain: [0, lastDay],
          ticks: xTicks,
          title: full ? t('sprintReport.burndownXTitle') : undefined,
        }}
        y={{
          domain: [0, yMax],
          ticks: yTicks,
          title: full
            ? burndown.statistic === 'story_points'
              ? t('sprintReport.burndownYTitlePoints')
              : t('sprintReport.burndownYTitleIssues')
            : undefined,
        }}
        description={description}
        ariaLabel={t('sprintReport.burndown')}
        annotations={annotations}
        referenceLines={referenceLines}
        legend={legend}
        hideLegend={!full}
        width={full ? 600 : 360}
        height={full ? 300 : 160}
        margin={full ? undefined : { top: 8, right: 8, bottom: 22, left: 30 }}
        dataTable={dataTable}
      />
      {empty ? (
        <p className="text-xs text-(--el-text-muted)">{t('sprintReport.burndownEmptySprint')}</p>
      ) : null}
    </div>
  );
}

function signed(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}
