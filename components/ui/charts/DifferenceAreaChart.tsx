import { cn } from '@/lib/utils/cn';
import { ChartFrame } from './ChartFrame';
import { ChartLegend } from './ChartLegend';
import { ChartDataTable, type ChartDataTableProps, type DataTableRow } from './ChartDataTable';
import { differenceBands, polygonPath, type XYPoint } from './geometry';
import { linePath, type PixelPoint } from './scale';
import { chartColor, type ChartAxis, type ChartLegendItem, type ChartMargin } from './tokens';

/** A point on the created/resolved series — a bucket count over time. */
export type DiffSeriesPoint = XYPoint;

export interface DifferenceAreaChartProps {
  /** The created-per-bucket series (info-toned line). */
  created: DiffSeriesPoint[];
  /** The resolved-per-bucket series (success-toned line). Same bucket x's as `created`. */
  resolved: DiffSeriesPoint[];
  x: ChartAxis;
  y: ChartAxis;
  /** The accessible `<desc>` summary (both series + where each leads). */
  description: string;
  ariaLabel?: string;
  createdLabel?: string;
  resolvedLabel?: string;
  width?: number;
  height?: number;
  margin?: Partial<ChartMargin>;
  /** Override the derived legend. */
  legend?: ChartLegendItem[];
  /** Override the derived a11y data table. */
  dataTable?: Omit<ChartDataTableProps, 'className'>;
  hideLegend?: boolean;
  className?: string;
}

const DIFF_FILL_OPACITY = 0.2;

/**
 * DifferenceAreaChart — the created-vs-resolved chart form (Story 6.3.4),
 * grown inside the 4.6.2 layer (no charting library). Two series over time
 * buckets, reusing the shared `ChartFrame` axes/gridlines/ticks/legend, with
 * the difference between them SHADED: `--el-chart-deficit` (red) where created
 * outpaces resolved (backlog growing), `--el-chart-surplus` (green) where
 * resolved outpaces created (catching up), split at each crossover by the pure
 * `differenceBands` geometry. The cumulative variant is just running-summed
 * data — no separate form. PURE presentational, so 6.3.5/6.3.6 bind it to the
 * 6.3.2 reads. The series read by line + legend label + a `<table>` fallback,
 * never colour alone (finding #35).
 */
export function DifferenceAreaChart({
  created,
  resolved,
  x,
  y,
  description,
  ariaLabel,
  createdLabel = 'Created',
  resolvedLabel = 'Resolved',
  width = 600,
  height = 300,
  margin,
  legend,
  dataTable,
  hideLegend = false,
  className,
}: DifferenceAreaChartProps) {
  const legendItems = legend ?? [
    { label: createdLabel, color: chartColor.created, kind: 'line', emphasis: true },
    { label: resolvedLabel, color: chartColor.resolved, kind: 'line', emphasis: true },
    { label: 'Backlog ↑', color: chartColor.deficit, kind: 'swatch' },
    { label: 'Catching up', color: chartColor.surplus, kind: 'swatch' },
  ];
  const table = dataTable ?? deriveTable(created, resolved, x, createdLabel, resolvedLabel);

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
        {({ xScale, yScale }) => {
          const toPixels = (pts: DiffSeriesPoint[]): PixelPoint[] =>
            pts.map((p) => ({ x: xScale(p.x), y: yScale(p.y) }));
          const bands = differenceBands(created, resolved);
          return (
            <>
              {/* difference fills — drawn under the lines, split at crossovers */}
              {bands.map((band, i) => (
                <path
                  key={`band-${i}`}
                  d={polygonPath(band.polygon.map((p) => ({ x: xScale(p.x), y: yScale(p.y) })))}
                  fill={band.kind === 'deficit' ? chartColor.deficit : chartColor.surplus}
                  opacity={DIFF_FILL_OPACITY}
                  stroke="none"
                />
              ))}

              {/* the two series lines */}
              <path
                d={linePath(toPixels(created))}
                fill="none"
                stroke={chartColor.created}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d={linePath(toPixels(resolved))}
                fill="none"
                stroke={chartColor.resolved}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          );
        }}
      </ChartFrame>
      <ChartDataTable {...table} />
    </div>
  );
}

function deriveTable(
  created: DiffSeriesPoint[],
  resolved: DiffSeriesPoint[],
  x: ChartAxis,
  createdLabel: string,
  resolvedLabel: string,
): Omit<ChartDataTableProps, 'className'> {
  const labelFor = (value: number): string =>
    x.ticks.find((t) => t.value === value)?.label ?? String(value);
  const xs = Array.from(new Set([...created.map((p) => p.x), ...resolved.map((p) => p.x)])).sort(
    (a, b) => a - b,
  );
  const rows: DataTableRow[] = xs.map((xv) => ({
    header: labelFor(xv),
    cells: [
      { value: created.find((p) => p.x === xv)?.y ?? '—', numeric: true },
      { value: resolved.find((p) => p.x === xv)?.y ?? '—', numeric: true },
    ],
  }));
  return {
    caption: `${createdLabel} vs ${resolvedLabel} by ${x.title ?? 'bucket'}.`,
    columns: [x.title ?? 'Bucket', createdLabel, resolvedLabel],
    rows,
  };
}
