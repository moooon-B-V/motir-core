'use client';

import { HBarChartView, type HBarChartViewProps } from './HBarChartView';
import { useChartWidth } from './useChartWidth';

/**
 * HBarChart in page mode (Story MOTIR-8919): lays the chart out at the
 * container's MEASURED width, so a wider page draws a wider plot instead of
 * taller rows. The height is the row formula (it depends on the row count, not
 * the width), applied as a fixed pixel height.
 */
export function HBarChartPage(props: Omit<HBarChartViewProps, 'containerRef' | 'fixedHeight'>) {
  const { ref, width } = useChartWidth<HTMLDivElement>(props.width ?? 600);
  return <HBarChartView {...props} width={width} containerRef={ref} fixedHeight />;
}
