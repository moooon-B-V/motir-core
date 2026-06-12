import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';
import { ChartDataTable, type ChartDataTableProps, type DataTableRow } from './ChartDataTable';
import { donutSegments, type DonutInput, type DonutSegment } from './geometry';
import { chartCategorical, chartColor } from './tokens';

/** One slice of the distribution donut — a finite-value group + its count. */
export type DonutDatum = DonutInput;

export interface DonutChartProps {
  data: DonutDatum[];
  /** Accessible `<desc>` summary naming every segment as count + percentage. */
  description: string;
  /** Optional short `aria-label`; the `<desc>` carries the detail. */
  ariaLabel?: string;
  /** Noun for the centre-hole total, e.g. "issues" → "80 issues". */
  totalNoun?: string;
  /** Column header for the data-table group column (e.g. "Status"). */
  statisticLabel?: string;
  /** Square SVG viewBox size (default 220 — the 6.3.3 widget proportion). */
  size?: number;
  /** Inner-hole radius as a fraction of the outer radius (default 0.587 — the mock). */
  innerRatio?: number;
  /** How many distinct ramp hues before the overflow rollup (default 7). */
  rampLength?: number;
  /** `side` = compact widget legend (default); `below` = the report-page layout. */
  legendLayout?: 'side' | 'below';
  /** Override the derived a11y data table. */
  dataTable?: Omit<ChartDataTableProps, 'className'>;
  /** Rendered when there is no positive data (never `NaN` geometry). */
  emptyState?: ReactNode;
  className?: string;
}

/** Round to ≤1 dp, drop a trailing `.0`, append `%`. */
function formatPercent(p: number): string {
  const r = Math.round(p * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)}%`;
}

function segmentColor(seg: DonutSegment): string {
  return seg.neutral
    ? chartColor.categoricalNone
    : (chartCategorical[seg.colorIndex] ?? chartColor.categoricalNone);
}

/**
 * DonutChart — the distribution chart form (Story 6.3.4), grown inside the
 * 4.6.2 token-aware SVG layer (no charting library, the recorded decision).
 *
 * Annular segments from `(label, value)` data, drawn as arc paths by the pure
 * `donutSegments` geometry; colour cycles the `--el-chart-cat-*` ramp, the
 * "None" group is the neutral grey, and beyond the ramp length the tail rolls
 * into a "+N more" wedge + legend row (never indistinguishable repeats). The
 * centre hole shows the total. PURE presentational — typed data in, SVG out —
 * so 6.3.5 binds it to the distribution widget and 6.3.6 to the report page.
 * The visible legend carries count + percentage and a `<table>` fallback
 * re-expresses the segments, so the chart reads as text+number, never colour
 * alone (finding #35).
 */
export function DonutChart({
  data,
  description,
  ariaLabel,
  totalNoun = 'total',
  statisticLabel = 'Group',
  size = 220,
  innerRatio = 0.587,
  rampLength = chartCategorical.length,
  legendLayout = 'side',
  dataTable,
  emptyState,
  className,
}: DonutChartProps) {
  const descId = useId();
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size / 2 - size * 0.082;
  const innerR = outerR * innerRatio;
  const segments = donutSegments(data, { cx, cy, outerR, innerR }, { rampLength });
  const total = segments.reduce((s, seg) => s + seg.value, 0);

  if (segments.length === 0) {
    return (
      <div className={cn('font-sans text-sm text-(--el-text-muted)', className)}>
        {emptyState ?? <p>No data to chart yet.</p>}
      </div>
    );
  }

  const table = dataTable ?? deriveTable(segments, statisticLabel);

  return (
    <div className={cn('font-sans', className)}>
      <div
        className={cn(
          'flex gap-5',
          legendLayout === 'side' ? 'items-center' : 'flex-col items-center',
        )}
      >
        <svg
          viewBox={`0 0 ${size} ${size}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={ariaLabel ?? description}
          aria-describedby={descId}
          className="block h-auto shrink-0"
          style={{ width: size * 0.71 }}
        >
          <desc id={descId}>{description}</desc>
          {segments.map((seg, i) => (
            <path
              key={`${seg.label}-${i}`}
              d={seg.path}
              fill={segmentColor(seg)}
              fillRule="evenodd"
            />
          ))}
          <text
            x={cx}
            y={cy - 2}
            textAnchor="middle"
            className="fill-(--el-text) font-semibold"
            style={{ fontSize: size * 0.127 }}
          >
            {total}
          </text>
          <text
            x={cx}
            y={cy + size * 0.064}
            textAnchor="middle"
            className="fill-(--el-text-muted)"
            style={{ fontSize: size * 0.055 }}
          >
            {totalNoun}
          </text>
        </svg>

        <ul
          className={cn(
            'list-none p-0 m-0 flex',
            legendLayout === 'side'
              ? 'flex-col gap-1.5 min-w-0 flex-1'
              : 'flex-wrap gap-x-5 gap-y-1.5',
          )}
        >
          {segments.map((seg, i) => (
            <li
              key={`${seg.label}-${i}`}
              className="inline-flex items-center gap-2 text-xs leading-tight"
            >
              <span
                aria-hidden="true"
                className="inline-block w-3 h-3 rounded-(--radius-badge) shrink-0"
                style={{ background: segmentColor(seg) }}
              />
              <span className="text-(--el-text-secondary) truncate">{seg.label}</span>
              <span className="ml-auto pl-2 font-semibold text-(--el-text) tabular-nums">
                {seg.value}
              </span>
              <span className="text-(--el-text-muted) tabular-nums w-12 text-right">
                {formatPercent(seg.percentage)}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <ChartDataTable {...table} />
    </div>
  );
}

function deriveTable(
  segments: DonutSegment[],
  statisticLabel: string,
): Omit<ChartDataTableProps, 'className'> {
  const rows: DataTableRow[] = segments.map((seg) => ({
    header: seg.label,
    cells: [
      { value: seg.value, numeric: true },
      { value: formatPercent(seg.percentage), numeric: true },
    ],
  }));
  return {
    caption: `Distribution by ${statisticLabel.toLowerCase()} — count and percentage per group.`,
    columns: [statisticLabel, 'Count', '%'],
    rows,
  };
}
