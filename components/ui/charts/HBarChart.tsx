import { HBarChartPage } from './HBarChartPage';
import { HBarChartView, type HBarChartViewProps } from './HBarChartView';

export type { HBarDatum } from './HBarChartView';

export interface HBarChartProps extends Omit<HBarChartViewProps, 'containerRef' | 'fixedHeight'> {
  /**
   * Page mode (Story MOTIR-8919): lay out at the container's MEASURED width so a
   * wider page draws a wider plot, not taller rows. The height is the row
   * formula, which depends on the row count only. Default mode is unchanged.
   */
  fit?: 'page';
}

/**
 * HBarChart — a horizontal, ranked SVG bar chart (Story 8.8 · Subtask 8.8.13).
 * See `HBarChartView` for the drawing; this chooses between the default
 * fixed-viewBox form and the measured page form.
 */
export function HBarChart({ fit, ...props }: HBarChartProps) {
  return fit === 'page' ? <HBarChartPage {...props} /> : <HBarChartView {...props} />;
}
