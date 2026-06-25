'use client';

import { useLocale, useTranslations } from 'next-intl';
import { LineChart, chartColor, niceTicks } from '@/components/ui/charts';
import type {
  AxisTick,
  ChartLegendItem,
  DataTableRow,
  LineSeries,
  ReferenceLine,
} from '@/components/ui/charts';
import type { CycleGraphDayDto, CycleGraphDto } from '@/lib/dto/reports';

// The SPRINT CYCLE GRAPH chart (Story 8.14 · Subtask 8.14.5) — Linear's reframe
// of the burndown: a burn-UP of LIVE scope vs completed, per
// design/reports/cycle-graph.mock.html. Binds the 4.6.2 `LineChart` primitive to
// the 8.14.4 `getSprintCycleGraph` data. PURE presentational: the host fetches
// the `CycleGraphDto` and this renders the four series + the scope-creep metric.
//
//   • SCOPE (gray, line + faint area) — the live total estimate, the ceiling.
//   • COMPLETED (blue, solid line + area) — points done by each day, burns UP.
//   • STARTED (amber, solid line) — points that left `todo`; sits between
//     completed and scope (the band is the in-progress work).
//   • TARGET (blue dotted) — the ideal even descent of the start scope to 0 over
//     the sprint's WORKING days; the actual remaining (scope − completed) reads
//     on/behind pace against it.
//   • SCOPE CREEP (amber chip) — % of scope added after start.
//
//   • `full` (sprint-report seam) — axes + day ticks + legend + value labels +
//     the scope-creep chip + the data-table fallback.
//   • `compact` (board / scrum-header slot) — a smaller frame drawn to "today"
//     (the dashed vertical marker), legend + table chrome dropped, but the four
//     series + the today marker + the `<desc>` + the scope-creep chip stay.
//
// Degraded states stay total (never `NaN`): a wholly-unestimated sprint arrives
// as the `issue_count` series (the Y title flips to issues); an empty sprint
// (no scope) draws flat-0 lines with the "no scope yet" note. Colour via the new
// `--el-chart-cycle-*` tokens (the `chartColor` map), shape via element-semantic
// tokens; the series read as text+number via the legend + `<desc>` + data table
// (finding #35).

/** The index of the last day with a drawn (non-null) scope value — the cycle
 *  graph's cutoff: "today" for an active sprint, completion for a closed one.
 *  -1 when no day is drawn (a degenerate series). */
export function cycleCutoffIndex(days: CycleGraphDayDto[]): number {
  let cutoff = -1;
  for (let i = 0; i < days.length; i++) {
    if (days[i]?.scope != null) cutoff = i;
  }
  return cutoff;
}

const STATISTIC_LABEL_KEY = {
  story_points: 'statisticStoryPoints',
  issue_count: 'statisticIssueCount',
} as const;

/** Month + day, no year — the chart-sub window form; the report's meta line
 *  already carries the year-qualified window. */
function formatChartDay(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function CycleGraphChart({
  cycle,
  variant,
}: {
  cycle: CycleGraphDto;
  variant: 'full' | 'compact';
}) {
  const t = useTranslations('backlog.sprintReport');
  const tStat = useTranslations('settings.estimation');
  const locale = useLocale();

  const full = variant === 'full';
  const { days, committedAtStart, scopeCreepPct, state } = cycle;
  const points = cycle.statistic === 'story_points';
  const lastDay = Math.max(days.length - 1, 1);
  const cutoff = cycleCutoffIndex(days);

  const endScope = cutoff >= 0 ? (days[cutoff]?.scope ?? 0) : committedAtStart;
  const endCompleted = cutoff >= 0 ? (days[cutoff]?.completed ?? 0) : 0;
  const endStarted = cutoff >= 0 ? (days[cutoff]?.started ?? 0) : 0;
  const endTarget = cutoff >= 0 ? (days[cutoff]?.target ?? 0) : committedAtStart;
  const remaining = Math.max(0, endScope - endCompleted);
  const empty = days.every((d) => (d.scope ?? 0) === 0) && committedAtStart === 0;

  const statisticLabel = tStat(STATISTIC_LABEL_KEY[cycle.statistic]);
  const scopeLabel = t('cycleScope');
  const completedLabel = t('cycleCompleted');
  const startedLabel = t('cycleStarted');
  const targetLabel = t('cycleTarget');
  const creepPercent = Math.round(scopeCreepPct * 100);

  // ── Axes ──────────────────────────────────────────────────────────────────
  const maxY = Math.max(
    1,
    committedAtStart,
    ...days.map((d) => Math.max(d.scope ?? 0, d.started ?? 0, d.target)),
  );
  let yTickValues: number[];
  let yMax: number;
  if (empty) {
    yTickValues = [0];
    yMax = 1;
  } else {
    yTickValues = niceTicks(maxY);
    yMax = Math.max(maxY, yTickValues[yTickValues.length - 1] ?? maxY);
  }
  const yTicks: AxisTick[] = yTickValues.map((value) => ({ value, label: String(value) }));

  // Full: every day (thinned past 12 to keep labels legible); compact: start /
  // today / end only.
  const xStep = full ? Math.max(1, Math.ceil(days.length / 12)) : 1;
  const xTickValues = full
    ? Array.from(new Set([...days.map((_, i) => i).filter((i) => i % xStep === 0), lastDay]))
    : Array.from(new Set([0, ...(state === 'active' && cutoff > 0 ? [cutoff] : []), lastDay]));
  const xTicks: AxisTick[] = xTickValues
    .sort((a, b) => a - b)
    .map((value) => ({ value, label: String(value) }));

  // ── Series ────────────────────────────────────────────────────────────────
  // The three ACTUAL series are drawn only up to the cutoff (nulls after are
  // future days); the TARGET spans the whole window (the ideal line).
  const drawn = days.slice(0, cutoff + 1);
  const series: LineSeries[] = [
    {
      id: 'target',
      label: targetLabel,
      points: days.map((d, i) => ({ x: i, y: d.target })),
      color: chartColor.cycleTarget,
      interpolation: 'linear',
      dashed: true,
      strokeWidth: 1.75,
    },
    {
      id: 'scope',
      label: scopeLabel,
      points: drawn.map((d, i) => ({ x: i, y: d.scope })),
      color: chartColor.cycleScope,
      interpolation: 'linear',
      area: true,
      strokeWidth: full ? 2 : 1.75,
    },
    {
      id: 'started',
      label: startedLabel,
      points: drawn.map((d, i) => ({ x: i, y: d.started })),
      color: chartColor.cycleStarted,
      interpolation: 'linear',
      strokeWidth: full ? 2 : 1.75,
    },
    {
      id: 'completed',
      label: completedLabel,
      points: drawn.map((d, i) => ({ x: i, y: d.completed })),
      color: chartColor.cycleCompleted,
      interpolation: 'linear',
      area: true,
      strokeWidth: full ? 2.75 : 2.5,
      markers: 'endpoint',
    },
  ];

  // The "today" vertical marker — a LIVE sprint only (a completed sprint's
  // series simply end at `completedAt`).
  const referenceLines: ReferenceLine[] =
    state === 'active' && cutoff >= 0
      ? [
          {
            orientation: 'vertical',
            value: cutoff,
            color: chartColor.axis,
            dashed: true,
            legendLabel: full ? t('cycleToday') : undefined,
          },
        ]
      : [];

  // Explicit legend (order: Scope · Completed · Started · Target, per the design)
  // + the today rule. The series-derived legend would list them in draw order.
  const legend: ChartLegendItem[] = [
    { label: scopeLabel, color: chartColor.cycleScope, kind: 'line' },
    { label: completedLabel, color: chartColor.cycleCompleted, kind: 'line', emphasis: true },
    { label: startedLabel, color: chartColor.cycleStarted, kind: 'line' },
    { label: targetLabel, color: chartColor.cycleTarget, kind: 'dash' },
    ...(state === 'active' && cutoff >= 0
      ? [{ label: t('cycleToday'), color: chartColor.axis, kind: 'dash' as const }]
      : []),
  ];

  // ── A11y — the `<desc>` summary + the data-table fallback (finding #35) ──
  const description =
    state === 'active'
      ? t('cycleDescActive', {
          day: Math.max(cutoff, 0),
          total: lastDay,
          completed: endCompleted,
          scope: endScope,
          started: endStarted,
          remaining,
          target: Math.round(endTarget),
          statistic: statisticLabel,
        })
      : t('cycleDescComplete', {
          total: lastDay,
          completed: endCompleted,
          scope: endScope,
          remaining,
          statistic: statisticLabel,
        });

  const dayHeader = (i: number): string =>
    state === 'active' && i === cutoff ? t('cycleTableToday', { day: i }) : String(i);
  const cell = (v: number | null) => ({ value: v ?? '—', numeric: true });
  const rows: DataTableRow[] = days.map((d, i) => ({
    header: dayHeader(i),
    cells: [cell(d.scope), cell(d.completed), cell(d.started), { value: d.target, numeric: true }],
  }));
  const dataTable = {
    caption: t('cycleTableCaption', { statistic: statisticLabel }),
    columns: [t('cycleTableDay'), scopeLabel, completedLabel, startedLabel, targetLabel],
    rows,
  };

  // The muted chart-sub line under the section title (window · state · scope).
  const subLine = [
    t('metaWindow', {
      start: formatChartDay(cycle.startDate, locale),
      end: formatChartDay(cycle.endDate, locale),
    }),
    t('cycleSubState', { state }),
    points
      ? t('cycleSubScopePoints', { scope: endScope })
      : t('cycleSubScopeIssues', { scope: endScope }),
  ].join(' · ');

  // The scope-creep chip (amber tint background + strong text — finding #35) is
  // shown whenever scope moved after start (positive or negative). Both forms
  // carry it (the design keeps it on the compact variant too).
  const creepChip =
    creepPercent !== 0 ? (
      <span className="inline-flex w-fit items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-peach) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong)">
        <span className="size-1.5 rounded-full bg-(--el-chart-cycle-scope)" aria-hidden />
        {t('cycleScopeCreep', { pct: creepPercent })}
      </span>
    ) : null;

  // compact (board slot): min-w-0 lets the chart subtree shrink within the
  // fixed-width burndown slot so its data table can't force overflow
  // (MOTIR-1329). full keeps its natural width inside the report card.
  return (
    <div className={`flex flex-col ${full ? 'gap-2' : 'min-w-0 gap-1'}`}>
      {full ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-(--el-text-muted)">{subLine}</span>
          {creepChip}
        </div>
      ) : null}
      <LineChart
        series={series}
        x={{
          domain: [0, lastDay],
          ticks: xTicks,
          title: full ? t('cycleXTitle') : undefined,
        }}
        y={{
          domain: [0, yMax],
          ticks: yTicks,
          title: full ? (points ? t('cycleYTitlePoints') : t('cycleYTitleIssues')) : undefined,
        }}
        description={description}
        ariaLabel={t('cycleGraph')}
        referenceLines={referenceLines}
        legend={legend}
        hideLegend={!full}
        width={full ? 600 : 360}
        height={full ? 300 : 160}
        margin={full ? undefined : { top: 8, right: 8, bottom: 22, left: 30 }}
        dataTable={dataTable}
      />
      {!full && creepChip ? creepChip : null}
      {empty ? <p className="text-xs text-(--el-text-muted)">{t('cycleEmptySprint')}</p> : null}
    </div>
  );
}
