/**
 * Token-aware SVG chart primitives (Story 4.6.2) — the reusable viz layer.
 *
 * Built once here, consumed by the burndown (4.6.5), the velocity (4.6.6),
 * AND Story 6.3's dashboards ("Charts reuse the viz from Epic 4"). No charting
 * library: small hand-rolled SVG that consumes the `--el-chart-*` design
 * tokens directly (see `design/reports/design-notes.md`). Every chart ships a
 * visible legend + a `<desc>` summary + a data-table fallback, so the series
 * read as text+number, never colour alone (finding #35).
 */
export { LineChart } from './LineChart';
export type { LineChartProps, LineSeries, ChartAnnotation, ReferenceLine } from './LineChart';

export { BarChart } from './BarChart';
export type { BarChartProps, BarSeries, BarGroup, BarReferenceLine } from './BarChart';

export { ChartFrame } from './ChartFrame';
export type { ChartFrameProps, ChartFrameScales, PlotBox } from './ChartFrame';

export { ChartLegend } from './ChartLegend';
export type { ChartLegendProps } from './ChartLegend';

export { ChartDataTable } from './ChartDataTable';
export type { ChartDataTableProps, DataTableRow, DataTableCell } from './ChartDataTable';

// Story 6.3.4 — the donut + difference/area forms (the viz Story 6.3 reuses).
export { DonutChart } from './DonutChart';
export type { DonutChartProps, DonutDatum } from './DonutChart';

export { DifferenceAreaChart } from './DifferenceAreaChart';
export type { DifferenceAreaChartProps, DiffSeriesPoint } from './DifferenceAreaChart';

export { chartColor, chartCategorical } from './tokens';
export type { ChartColor, ChartAxis, AxisTick, ChartMargin, ChartLegendItem } from './tokens';

export {
  donutSegments,
  annularWedgePath,
  pointOnCircle,
  differenceBands,
  polygonPath,
} from './geometry';
export type { DonutInput, DonutGeometry, DonutSegment, DiffBand, XYPoint } from './geometry';

export { linearScale, linePath, stepPath, areaPath, niceTicks, niceMax } from './scale';
export type { Scale, DataPoint, PixelPoint } from './scale';
