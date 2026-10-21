import type { ReactNode } from 'react';
import { ChartFrameSvg, type ChartFrameBaseProps, type ChartFrameScales } from './ChartFrameSvg';
import { PageChartFrame } from './PageChartFrame';

export type { PlotBox, ChartFrameScales, HitBand } from './ChartFrameSvg';

export interface ChartFrameProps extends Omit<ChartFrameBaseProps, 'xTickAngle' | 'children'> {
  /**
   * `'page'` (Story MOTIR-8919): measure the container, fill its whole width,
   * pick the height from the viewport (`clamp(280px, 44vh, 420px)`) and thin /
   * angle the x labels so none overlap. `width` / `height` then only seed the
   * server and first paint. Omitted = the fixed-ratio chart every existing call
   * site renders, byte for byte.
   */
  fit?: 'page';
  /** Draw the data marks; receives the scales + plot box. */
  children: (scales: ChartFrameScales) => ReactNode;
}

/**
 * ChartFrame — the shared SVG scaffold every chart composes (Story 4.6.2).
 * See `ChartFrameSvg` for the scaffold itself; this component only chooses
 * between the fixed-ratio default and the measured `fit="page"` mode.
 */
export function ChartFrame({ fit, ...props }: ChartFrameProps) {
  if (fit === 'page') return <PageChartFrame {...props} />;
  return <ChartFrameSvg {...props} />;
}
