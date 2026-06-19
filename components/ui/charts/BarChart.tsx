import { cn } from '@/lib/utils/cn';
import { ChartFrame } from './ChartFrame';
import { ChartLegend } from './ChartLegend';
import { ChartDataTable, type ChartDataTableProps, type DataTableRow } from './ChartDataTable';
import type { AxisTick, ChartLegendItem, ChartMargin } from './tokens';

/** A bar series (e.g. "Committed", "Completed") — one bar per category. */
export interface BarSeries {
  label: string;
  /** A `--el-chart-*` colour (use the `chartColor` map). */
  color: string;
}

/** One category (a completed sprint) — values aligned to the `series` order. */
export interface BarGroup {
  label: string;
  values: number[];
}

/** A horizontal reference line (the average-completed forecast). */
export interface BarReferenceLine {
  value: number;
  color: string;
  label?: string;
  legendLabel?: string;
  dashed?: boolean;
}

export interface BarChartProps {
  series: BarSeries[];
  groups: BarGroup[];
  /** Y-axis ticks (points). The domain top is the last tick's value. */
  yTicks: AxisTick[];
  yTitle?: string;
  xTitle?: string;
  description: string;
  ariaLabel?: string;
  referenceLine?: BarReferenceLine;
  /** Draw the numeric value above each bar (default true — read as text). */
  valueLabels?: boolean;
  /** Format a bar's value label (default `String(value)`). Receives the value
   * plus the (group, series) indices so a report can render "—" for an
   * event-less bucket instead of a misleading "0" (the 4.5.2 rule). */
  valueFormat?: (value: number, groupIndex: number, seriesIndex: number) => string;
  /** Cap the number of X-axis tick LABELS to ≤ this many, evenly spread (first +
   * last always kept) — for a many-bucket report axis (a daily 30/120-bucket
   * window) where labelling every bar overlaps into an unreadable smear (the
   * `spreadTicks` idiom the difference/area chart uses). Default: undefined =
   * label every group (the velocity primitive, ≤ a handful of bars). When set,
   * per-bar value labels are also drawn only on the labelled bars, so the chart
   * reads cleanly; the full series stays in the data table. */
  maxXTicks?: number;
  width?: number;
  height?: number;
  margin?: Partial<ChartMargin>;
  legend?: ChartLegendItem[];
  dataTable?: Omit<ChartDataTableProps, 'className'>;
  hideLegend?: boolean;
  className?: string;
}

/**
 * BarChart — a grouped, token-aware SVG bar chart (Story 4.6.2).
 *
 * The velocity primitive: N categories (completed sprints) × M bars
 * (committed vs completed) + an optional average reference line. PURE
 * presentational — typed data props in, SVG out — so 4.6.6 binds it to
 * `getVelocity` (4.6.4) and Story 6.3 reuses it. The committed/completed pair
 * is distinguished by a TEXT legend + value labels + the data table, never
 * colour alone (finding #35); colour via `--el-chart-*`.
 */
export function BarChart({
  series,
  groups,
  yTicks,
  yTitle,
  xTitle,
  description,
  ariaLabel,
  referenceLine,
  valueLabels = true,
  valueFormat,
  maxXTicks,
  width = 600,
  height = 300,
  margin,
  legend,
  dataTable,
  hideLegend = false,
  className,
}: BarChartProps) {
  const yMax = yTicks.length > 0 ? Math.max(...yTicks.map((t) => t.value)) : 1;
  const n = groups.length;
  // Which group indices get an X-axis label: every group by default (velocity),
  // or an evenly-spread subset (first + last always) when `maxXTicks` caps a
  // many-bucket report axis so the date labels don't overlap.
  const labelledIdx = pickLabelIndices(n, maxXTicks);
  const xAxis = {
    domain: [0, Math.max(1, n)] as [number, number],
    ticks: [...labelledIdx].map((i) => ({ value: i + 0.5, label: groups[i]!.label })),
    title: xTitle,
  };
  const legendItems = legend ?? deriveLegend(series, referenceLine);
  const table = dataTable ?? deriveTable(series, groups);

  return (
    <div className={cn('font-sans', className)}>
      {!hideLegend && legendItems.length > 0 && (
        <ChartLegend items={legendItems} className="mb-3" />
      )}
      <ChartFrame
        width={width}
        height={height}
        margin={margin}
        x={xAxis}
        y={{ domain: [0, yMax], ticks: yTicks, title: yTitle }}
        description={description}
        ariaLabel={ariaLabel}
      >
        {({ yScale, plot }) => {
          const bandWidth = plot.width / Math.max(1, n);
          const groupInner = bandWidth * 0.62;
          const gap = 4;
          const barCount = Math.max(1, series.length);
          const barWidth = Math.max(2, (groupInner - gap * (barCount - 1)) / barCount);
          const baseY = yScale(0);
          return (
            <>
              {groups.map((group, gi) => {
                const center = plot.left + (gi + 0.5) * bandWidth;
                const startX = center - groupInner / 2;
                return (
                  <g key={`${group.label}-${gi}`}>
                    {series.map((s, si) => {
                      const value = group.values[si] ?? 0;
                      const topY = yScale(value);
                      const barX = startX + si * (barWidth + gap);
                      const barH = Math.max(0, baseY - topY);
                      return (
                        <g key={s.label}>
                          <rect
                            x={barX}
                            y={topY}
                            width={barWidth}
                            height={barH}
                            rx={2}
                            fill={s.color}
                          />
                          {valueLabels && labelledIdx.has(gi) && (
                            <text
                              className="text-[11px] font-semibold"
                              x={barX + barWidth / 2}
                              y={topY - 5}
                              fill={s.color}
                              textAnchor="middle"
                            >
                              {valueFormat ? valueFormat(value, gi, si) : value}
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </g>
                );
              })}

              {referenceLine && (
                <g>
                  <line
                    x1={plot.left}
                    x2={plot.right}
                    y1={yScale(referenceLine.value)}
                    y2={yScale(referenceLine.value)}
                    stroke={referenceLine.color}
                    strokeWidth={1.75}
                    strokeDasharray={referenceLine.dashed === false ? undefined : '6 4'}
                  />
                  {referenceLine.label && (
                    <text
                      className="text-[10.5px] font-semibold font-mono"
                      x={plot.left + 6}
                      y={yScale(referenceLine.value) - 4}
                      fill={referenceLine.color}
                    >
                      {referenceLine.label}
                    </text>
                  )}
                </g>
              )}
            </>
          );
        }}
      </ChartFrame>
      <ChartDataTable {...table} />
    </div>
  );
}

/**
 * The group indices that get an X-axis label. Without a `max` (or when there
 * are few enough bars) every group is labelled — the velocity default. With a
 * `max` and more bars than that, pick `max` evenly-spread indices, ALWAYS
 * including the first and last, so a many-bucket report axis (a daily window of
 * 30–120 buckets) shows a readable handful of date labels instead of an
 * overlapping smear. Returns a Set for O(1) membership (the value-label gate).
 */
function pickLabelIndices(n: number, max?: number): Set<number> {
  if (n <= 0) return new Set();
  if (!max || n <= max) return new Set(Array.from({ length: n }, (_, i) => i));
  const idx = new Set<number>();
  const step = (n - 1) / (max - 1);
  for (let i = 0; i < max; i++) idx.add(Math.round(i * step));
  return idx;
}

function deriveLegend(series: BarSeries[], ref?: BarReferenceLine): ChartLegendItem[] {
  const items: ChartLegendItem[] = series.map((s) => ({
    label: s.label,
    color: s.color,
    kind: 'swatch',
    emphasis: true,
  }));
  if (ref?.legendLabel) items.push({ label: ref.legendLabel, color: ref.color, kind: 'dash' });
  return items;
}

function deriveTable(
  series: BarSeries[],
  groups: BarGroup[],
): Omit<ChartDataTableProps, 'className'> {
  const rows: DataTableRow[] = groups.map((g) => ({
    header: g.label,
    cells: series.map((_, si) => ({ value: g.values[si] ?? 0, numeric: true })),
  }));
  return {
    caption: `${series.map((s) => s.label).join(' vs ')} per category.`,
    columns: ['Category', ...series.map((s) => s.label)],
    rows,
  };
}
