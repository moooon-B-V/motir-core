import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';
import { linearScale, type Scale } from './scale';
import type { ChartAxis, ChartMargin } from './tokens';

/** Plot-area bounds in SVG pixel coordinates (the band inside the margins). */
export interface PlotBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** What `ChartFrame` hands its render-prop child to draw the data marks. */
export interface ChartFrameScales {
  xScale: Scale;
  yScale: Scale;
  plot: PlotBox;
}

export interface ChartFrameProps {
  /**
   * viewBox width / height — these set the chart's intrinsic ASPECT RATIO, not
   * its rendered pixels. The SVG is `block w-full h-auto`, so it fills its
   * container's width and the height follows from this ratio.
   *
   * **Bounded-container contract (the bug-reports-chart-sizing fix).** Because
   * the SVG scales to its container, the CONSUMER owns the rendered size by
   * bounding the width: a dashboard-widget tile bounds it to the ~400 px tile;
   * a full-page report landing MUST wrap it in a max-width block (the report
   * pages use the `mx-auto max-w-[48rem]` card in ReportPageChrome) — otherwise the
   * chart paints the full page width and, at this ratio, runs below the fold.
   * An UNBOUNDED full-page mount is the bug, not a valid use.
   */
  width: number;
  height: number;
  margin?: Partial<ChartMargin>;
  x: ChartAxis;
  y: ChartAxis;
  /**
   * The accessible summary — rendered as `<desc>` and referenced by
   * `aria-describedby`, so the chart's `role="img"` is read as a sentence
   * describing every series (finding #35). Required: a chart is never an
   * unlabelled image.
   */
  description: string;
  /** Optional short `aria-label` (a headline; the `<desc>` carries detail). */
  ariaLabel?: string;
  /** Draw horizontal gridlines at the Y ticks (default true). */
  gridlines?: boolean;
  className?: string;
  /** Draw the data marks; receives the scales + plot box. */
  children: (scales: ChartFrameScales) => ReactNode;
}

const DEFAULT_MARGIN: ChartMargin = { top: 16, right: 16, bottom: 46, left: 44 };

/**
 * ChartFrame — the shared SVG scaffold every chart composes (Story 4.6.2):
 * the plot frame, X/Y axes + tick labels, gridlines, axis titles, and the
 * `role="img"` + `<desc>` a11y wiring. It owns the scales (a tiny linear map,
 * no d3) and hands them to a render-prop child that draws the marks — so the
 * `LineChart` and `BarChart` (and Story 6.3's future charts) share one
 * frame + scale + a11y implementation instead of re-deriving axes each time.
 *
 * Colour flows through `--el-chart-*` (plot/grid/axis) and `--el-text-*`
 * (titles); shape via SVG geometry (intrinsic, not a swappable surface).
 */
export function ChartFrame({
  width,
  height,
  margin,
  x,
  y,
  description,
  ariaLabel,
  gridlines = true,
  className,
  children,
}: ChartFrameProps) {
  const descId = useId();
  const m: ChartMargin = { ...DEFAULT_MARGIN, ...margin };
  const plot: PlotBox = {
    left: m.left,
    right: width - m.right,
    top: m.top,
    bottom: height - m.bottom,
    width: width - m.left - m.right,
    height: height - m.top - m.bottom,
  };
  const xScale = linearScale(x.domain, [plot.left, plot.right]);
  const yScale = linearScale(y.domain, [plot.bottom, plot.top]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      // Always carry an accessible NAME (axe `svg-img-alt`): the short label if
      // given, else the full summary. The `<desc>` adds the detail via
      // aria-describedby, so a screen reader reads the chart as a sentence.
      aria-label={ariaLabel ?? description}
      aria-describedby={descId}
      className={cn('block w-full h-auto', className)}
    >
      <desc id={descId}>{description}</desc>

      {/* plot background */}
      <rect
        x={plot.left}
        y={plot.top}
        width={plot.width}
        height={plot.height}
        rx={4}
        className="fill-(--el-chart-plot)"
      />

      {/* horizontal gridlines at the Y ticks */}
      {gridlines && (
        <g className="stroke-(--el-chart-grid)" strokeWidth={1}>
          {y.ticks.map((tick) => (
            <line
              key={`grid-${tick.value}`}
              x1={plot.left}
              x2={plot.right}
              y1={yScale(tick.value)}
              y2={yScale(tick.value)}
            />
          ))}
        </g>
      )}

      {/* axis lines */}
      <line
        x1={plot.left}
        y1={plot.top}
        x2={plot.left}
        y2={plot.bottom}
        className="stroke-(--el-chart-axis)"
        strokeWidth={1.5}
      />
      <line
        x1={plot.left}
        y1={plot.bottom}
        x2={plot.right}
        y2={plot.bottom}
        className="stroke-(--el-chart-axis)"
        strokeWidth={1.5}
      />

      {/* Y tick labels */}
      <g className="fill-(--el-chart-axis) text-[11px]" textAnchor="end">
        {y.ticks.map((tick) => (
          <text key={`yt-${tick.value}`} x={plot.left - 6} y={yScale(tick.value) + 4}>
            {tick.label}
          </text>
        ))}
      </g>

      {/* X tick labels */}
      <g className="fill-(--el-chart-axis) text-[11px]" textAnchor="middle">
        {x.ticks.map((tick) => (
          <text key={`xt-${tick.value}`} x={xScale(tick.value)} y={plot.bottom + 18}>
            {tick.label}
          </text>
        ))}
      </g>

      {/* axis titles */}
      {y.title && (
        <text
          className="fill-(--el-chart-axis) text-[11px]"
          x={14}
          y={(plot.top + plot.bottom) / 2}
          textAnchor="middle"
          transform={`rotate(-90 14 ${(plot.top + plot.bottom) / 2})`}
        >
          {y.title}
        </text>
      )}
      {x.title && (
        <text
          className="fill-(--el-chart-axis) text-[11px]"
          x={(plot.left + plot.right) / 2}
          y={height - 6}
          textAnchor="middle"
        >
          {x.title}
        </text>
      )}

      {children({ xScale, yScale, plot })}
    </svg>
  );
}
