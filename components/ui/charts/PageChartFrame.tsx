'use client';

import { ChartFrameSvg, type ChartFrameBaseProps } from './ChartFrameSvg';
import { fitXTicks } from './fitXTicks';
import { linearScale } from './scale';
import { pageChart } from './tokens';
import { useChartWidth } from './useChartWidth';

/** Left margin in page mode — room for 4-digit y labels (design panel 0). */
const PAGE_LEFT = 48;

/**
 * The measured `fit="page"` frame (Story MOTIR-8919): reads its container's
 * width, takes the viewport-derived height, thins the x labels with
 * `fitXTicks` and widens the bottom margin when it angles them. The viewBox is
 * the rendered size, so text keeps its 11 px at every width.
 */
export function PageChartFrame(props: Omit<ChartFrameBaseProps, 'xTickAngle'>) {
  const { ref, width, height } = useChartWidth<HTMLDivElement>(props.width);
  const m = { top: 16, right: 16, left: PAGE_LEFT, ...props.margin };
  const xScale = linearScale(props.x.domain, [m.left, width - m.right]);
  const fit = fitXTicks({ ticks: props.x.ticks, xScale });
  const bottom =
    props.margin?.bottom ?? (fit.angle ? pageChart.bottomAngled : pageChart.bottomFlat);
  return (
    <div ref={ref} className="w-full">
      <ChartFrameSvg
        {...props}
        width={width}
        height={height}
        margin={{ ...m, bottom }}
        x={{ ...props.x, ticks: fit.ticks }}
        xTickAngle={fit.angle}
      />
    </div>
  );
}
