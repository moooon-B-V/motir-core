import { useId } from 'react';
import { cn } from '@/lib/utils/cn';
import { ChartDataTable, type ChartDataTableProps } from './ChartDataTable';
import { ChartLegend } from './ChartLegend';
import { niceMax, niceTicks } from './scale';
import type { ChartLegendItem } from './tokens';

/** One horizontal bar — a ranked category (e.g. an assignee). */
export interface HBarDatum {
  /** The row label drawn in the left gutter (e.g. the assignee name). */
  label: string;
  /** The bar's magnitude (the active measure). */
  value: number;
  /** A `--el-chart-*` colour string (use the `chartCategorical` ramp / the
   * `chartColor.categoricalNone` neutral for an unset bucket). */
  color: string;
  /** The text drawn at the bar's end (defaults to the value). Lets the caller
   * format (e.g. "34 pts") without the chart knowing the unit. */
  valueLabel?: string;
}

export interface HBarChartProps {
  bars: HBarDatum[];
  /** The X-axis (value) title, drawn above the plot (e.g. "Story points (open)"). */
  xTitle?: string;
  /** The accessible `<desc>` summary — every series read as a sentence
   * (finding #35); required, a chart is never an unlabelled image. */
  description: string;
  /** Optional short `aria-label`; the `<desc>` carries the detail. */
  ariaLabel?: string;
  /** A visible text legend (finding #35) — colour is never the sole signal. */
  legend?: ChartLegendItem[];
  /** The a11y data-table fallback (the caller builds it from the same rows). */
  dataTable: Omit<ChartDataTableProps, 'className'>;
  /** Intrinsic SVG width (aspect-ratio anchor; the SVG is `w-full h-auto`). */
  width?: number;
  className?: string;
}

const ROW_HEIGHT = 37;
const BAR_HEIGHT = 22;
const LABEL_GUTTER = 132; // right-aligned category labels sit left of the plot
const RIGHT_PAD = 40; // room for the value label past the longest bar
const TOP_PAD = 26; // the X-axis title + top gridline
const BOTTOM_PAD = 26; // the X tick labels

/**
 * HBarChart — a horizontal, ranked SVG bar chart (Story 8.8 · Subtask 8.8.13).
 *
 * The WORKLOAD primitive: N categories (assignees) as horizontal bars sorted by
 * the caller (descending magnitude, the unassigned bucket last). A magnitude
 * RANKING reads directly as bar length — the justified deviation from Jira's
 * pie (a pie degrades past ~7 segments; the design note). PURE presentational —
 * typed data props in, SVG out — so the report page AND the dashboard gadget
 * share it. Each bar is named in the left gutter + valued at its end + in the
 * data table, never colour alone (finding #35); colour via `--el-chart-*`.
 *
 * Bounded-container contract (the ChartFrame precedent): the SVG scales to its
 * container width, so the CONSUMER bounds the width (the report page's
 * `max-w-[48rem]` card / the widget tile).
 */
export function HBarChart({
  bars,
  xTitle,
  description,
  ariaLabel,
  legend,
  dataTable,
  width = 600,
  className,
}: HBarChartProps) {
  const descId = useId();
  const n = Math.max(1, bars.length);
  const height = TOP_PAD + n * ROW_HEIGHT + BOTTOM_PAD;

  const plotLeft = LABEL_GUTTER;
  const plotRight = width - RIGHT_PAD;
  const plotWidth = plotRight - plotLeft;
  const plotTop = TOP_PAD;
  const plotBottom = height - BOTTOM_PAD;

  const maxValue = Math.max(0, ...bars.map((b) => b.value));
  const domainMax = niceMax(maxValue) || 1;
  const ticks = niceTicks(maxValue);
  const xScale = (v: number) => plotLeft + (v / domainMax) * plotWidth;

  return (
    <div className={cn('font-sans', className)}>
      {legend && legend.length > 0 && <ChartLegend items={legend} className="mb-3" />}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={ariaLabel ?? description}
        aria-describedby={descId}
        className="block h-auto w-full"
      >
        <desc id={descId}>{description}</desc>

        {/* plot background */}
        <rect
          x={plotLeft}
          y={plotTop}
          width={plotWidth}
          height={plotBottom - plotTop}
          rx={4}
          className="fill-(--el-chart-plot)"
        />

        {/* X gridlines + tick labels (value axis) */}
        <g className="stroke-(--el-chart-grid)" strokeWidth={1}>
          {ticks.map((t) => (
            <line key={`g-${t}`} x1={xScale(t)} x2={xScale(t)} y1={plotTop} y2={plotBottom} />
          ))}
        </g>
        <g className="fill-(--el-chart-axis) text-[11px]" textAnchor="middle">
          {ticks.map((t) => (
            <text key={`xt-${t}`} x={xScale(t)} y={plotBottom + 16}>
              {t}
            </text>
          ))}
        </g>

        {/* X-axis title (drawn above the plot, like the design mock) */}
        {xTitle && (
          <text
            className="fill-(--el-chart-axis) text-[11px]"
            x={(plotLeft + plotRight) / 2}
            y={12}
            textAnchor="middle"
          >
            {xTitle}
          </text>
        )}

        {/* rows: category label (left gutter) + bar + value label */}
        {bars.map((bar, i) => {
          const rowTop = plotTop + i * ROW_HEIGHT;
          const barY = rowTop + (ROW_HEIGHT - BAR_HEIGHT) / 2;
          const barW = Math.max(0, xScale(bar.value) - plotLeft);
          const labelText = bar.valueLabel ?? String(bar.value);
          return (
            <g key={`${bar.label}-${i}`}>
              <text
                className="fill-(--el-text-secondary) text-[12px]"
                x={plotLeft - 8}
                y={barY + BAR_HEIGHT / 2 + 4}
                textAnchor="end"
              >
                {bar.label}
              </text>
              <rect
                x={plotLeft}
                y={barY}
                width={barW}
                height={BAR_HEIGHT}
                rx={3}
                fill={bar.color}
              />
              <text
                className="fill-(--el-text) text-[12px] font-semibold"
                x={plotLeft + barW + 8}
                y={barY + BAR_HEIGHT / 2 + 4}
                textAnchor="start"
              >
                {labelText}
              </text>
            </g>
          );
        })}

        {/* Y axis line (the category baseline) */}
        <line
          x1={plotLeft}
          y1={plotTop}
          x2={plotLeft}
          y2={plotBottom}
          className="stroke-(--el-chart-axis)"
          strokeWidth={1.5}
        />
      </svg>
      <ChartDataTable {...dataTable} />
    </div>
  );
}
