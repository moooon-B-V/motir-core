import { cn } from '@/lib/utils/cn';
import { ChartFrame } from './ChartFrame';
import { ChartLegend } from './ChartLegend';
import { ChartDataTable, type ChartDataTableProps, type DataTableRow } from './ChartDataTable';
import { areaPath, linePath, stepPath, type DataPoint, type PixelPoint } from './scale';
import type { ChartAxis, ChartLegendItem, ChartMargin } from './tokens';

/** One line series (the guideline, the actual-remaining step line, …). */
export interface LineSeries {
  id: string;
  /** Series name — shown in the legend + the data-table column header. */
  label: string;
  points: DataPoint[];
  /** A `--el-chart-*` colour (use the `chartColor` map). */
  color: string;
  /** `step` holds-then-drops (burndown actual); `linear` is a straight join. */
  interpolation?: 'linear' | 'step';
  dashed?: boolean;
  strokeWidth?: number;
  /** Fill the area under the line (to the X axis). */
  area?: boolean;
  /** Point dots: `endpoint` marks only the last point, `all` marks each. */
  markers?: 'none' | 'endpoint' | 'all';
  /** Include in the derived legend (default true). */
  showInLegend?: boolean;
}

/** A discrete annotation in DATA coordinates (scope marker, baseline dot). */
export interface ChartAnnotation {
  x: number;
  y: number;
  color: string;
  shape?: 'circle' | 'diamond';
  label?: string;
  labelAnchor?: 'start' | 'middle' | 'end';
  /** Vertical nudge for the label (SVG px; negative = up). */
  labelDy?: number;
}

/** A straight reference line: a horizontal y= or vertical x= rule (in data space). */
export interface ReferenceLine {
  orientation: 'horizontal' | 'vertical';
  value: number;
  color: string;
  dashed?: boolean;
  label?: string;
  /** If set, the line gets a derived legend entry with this label. */
  legendLabel?: string;
}

export interface LineChartProps {
  series: LineSeries[];
  x: ChartAxis;
  y: ChartAxis;
  /** The accessible `<desc>` summary (every series + endpoint in words). */
  description: string;
  ariaLabel?: string;
  annotations?: ChartAnnotation[];
  referenceLines?: ReferenceLine[];
  width?: number;
  height?: number;
  margin?: Partial<ChartMargin>;
  /** Override the legend (else derived from series + reference lines). */
  legend?: ChartLegendItem[];
  /** Override the a11y data table (else derived from the series points). */
  dataTable?: Omit<ChartDataTableProps, 'className'>;
  /** Hide the visible legend (the `<desc>` + table still convey the series). */
  hideLegend?: boolean;
  className?: string;
}

const ANNOT_LABEL_CLASS = 'text-[10.5px] font-semibold font-mono';

/**
 * LineChart — a multi-series token-aware SVG line/area chart (Story 4.6.2).
 *
 * The burndown's primitive: it draws a straight `guideline` series and a
 * `step`-interpolated `actual` series, with optional point markers, area
 * fills, and reference lines (the "today" vertical, an average horizontal).
 * It is PURE presentational — typed data props in, SVG out, no fetching — so
 * 4.6.5 binds it to `getBurndownSeries` (4.6.3) and Story 6.3 reuses it for
 * dashboards. Colour via `--el-chart-*`; a visible legend + a `<desc>` summary
 * + a data-table fallback mean the series read as text+number (finding #35).
 */
export function LineChart({
  series,
  x,
  y,
  description,
  ariaLabel,
  annotations = [],
  referenceLines = [],
  width = 600,
  height = 300,
  margin,
  legend,
  dataTable,
  hideLegend = false,
  className,
}: LineChartProps) {
  const legendItems = legend ?? deriveLegend(series, referenceLines);
  const table = dataTable ?? deriveTable(series, x);

  return (
    <div className={cn('font-sans', className)}>
      {!hideLegend && legendItems.length > 0 && (
        <ChartLegend items={legendItems} className="mb-3" />
      )}
      <ChartFrame
        width={width}
        height={height}
        margin={margin}
        x={x}
        y={y}
        description={description}
        ariaLabel={ariaLabel}
      >
        {({ xScale, yScale, plot }) => {
          const toPixels = (pts: DataPoint[]): PixelPoint[] =>
            pts.map((p) => ({ x: xScale(p.x), y: p.y === null ? NaN : yScale(p.y) }));
          return (
            <>
              {/* reference lines (drawn under the series) */}
              {referenceLines.map((ref, i) => {
                const dash = ref.dashed ? '6 4' : undefined;
                if (ref.orientation === 'horizontal') {
                  const yPx = yScale(ref.value);
                  return (
                    <g key={`ref-${i}`}>
                      <line
                        x1={plot.left}
                        x2={plot.right}
                        y1={yPx}
                        y2={yPx}
                        stroke={ref.color}
                        strokeWidth={1.75}
                        strokeDasharray={dash}
                      />
                      {ref.label && (
                        <text
                          className={ANNOT_LABEL_CLASS}
                          x={plot.left + 6}
                          y={yPx - 4}
                          fill={ref.color}
                        >
                          {ref.label}
                        </text>
                      )}
                    </g>
                  );
                }
                const xPx = xScale(ref.value);
                return (
                  <g key={`ref-${i}`}>
                    <line
                      x1={xPx}
                      x2={xPx}
                      y1={plot.top}
                      y2={plot.bottom}
                      stroke={ref.color}
                      strokeWidth={1.5}
                      strokeDasharray={dash ?? '3 3'}
                    />
                    {ref.label && (
                      <text
                        className={ANNOT_LABEL_CLASS}
                        x={xPx}
                        y={plot.top - 3}
                        fill={ref.color}
                        textAnchor="middle"
                      >
                        {ref.label}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* series */}
              {series.map((s) => {
                const pixels = toPixels(s.points);
                const d = s.interpolation === 'step' ? stepPath(pixels) : linePath(pixels);
                const finite = pixels.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
                const last = finite[finite.length - 1];
                return (
                  <g key={s.id}>
                    {s.area && d && (
                      <path
                        d={areaPath(d, pixels, plot.bottom)}
                        fill={s.color}
                        fillOpacity={0.12}
                        stroke="none"
                      />
                    )}
                    <path
                      d={d}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={s.strokeWidth ?? 2.5}
                      strokeDasharray={s.dashed ? '5 5' : undefined}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    {s.markers === 'all' &&
                      finite.map((p, i) => (
                        <circle key={i} cx={p.x} cy={p.y} r={3.5} fill={s.color} />
                      ))}
                    {s.markers === 'endpoint' && last && (
                      <circle cx={last.x} cy={last.y} r={3.75} fill={s.color} />
                    )}
                  </g>
                );
              })}

              {/* annotations (scope markers, baseline dots) — drawn on top */}
              {annotations.map((a, i) => {
                const cx = xScale(a.x);
                const cy = yScale(a.y);
                return (
                  <g key={`annot-${i}`}>
                    {a.shape === 'diamond' ? (
                      <rect
                        x={cx - 5}
                        y={cy - 5}
                        width={10}
                        height={10}
                        rx={2}
                        transform={`rotate(45 ${cx} ${cy})`}
                        fill={a.color}
                      />
                    ) : (
                      <circle cx={cx} cy={cy} r={3.75} fill={a.color} />
                    )}
                    {a.label && (
                      <text
                        className={ANNOT_LABEL_CLASS}
                        x={cx + (a.labelAnchor === 'end' ? -8 : 8)}
                        y={cy + (a.labelDy ?? -6)}
                        fill={a.color}
                        textAnchor={a.labelAnchor ?? 'start'}
                      >
                        {a.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </>
          );
        }}
      </ChartFrame>
      <ChartDataTable {...table} />
    </div>
  );
}

function deriveLegend(series: LineSeries[], refs: ReferenceLine[]): ChartLegendItem[] {
  const items: ChartLegendItem[] = series
    .filter((s) => s.showInLegend !== false)
    .map((s) => ({
      label: s.label,
      color: s.color,
      kind: s.dashed ? 'dash' : 'line',
      emphasis: !s.dashed,
    }));
  for (const ref of refs) {
    if (ref.legendLabel)
      items.push({ label: ref.legendLabel, color: ref.color, kind: ref.dashed ? 'dash' : 'line' });
  }
  return items;
}

function deriveTable(series: LineSeries[], x: ChartAxis): Omit<ChartDataTableProps, 'className'> {
  const xLabelFor = (value: number): string =>
    x.ticks.find((t) => t.value === value)?.label ?? String(value);
  // union of x values across series, ascending
  const xs = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.x)))).sort(
    (a, b) => a - b,
  );
  const rows: DataTableRow[] = xs.map((xv) => ({
    header: xLabelFor(xv),
    cells: series.map((s) => {
      const pt = s.points.find((p) => p.x === xv);
      return { value: pt && pt.y !== null ? pt.y : '—', numeric: true };
    }),
  }));
  return {
    caption: `${series.map((s) => s.label).join(' vs ')} by ${x.title ?? 'x'}.`,
    columns: [x.title ?? 'x', ...series.map((s) => s.label)],
    rows,
  };
}
