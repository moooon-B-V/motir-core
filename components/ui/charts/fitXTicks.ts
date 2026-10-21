import type { AxisTick } from './tokens';
import { pageChart } from './tokens';

export interface FitXTicksInput {
  /** The ticks the caller passes — typically one per bucket. */
  ticks: AxisTick[];
  /** Data value → SVG x (the frame's scale, plot margins already applied). */
  xScale: (value: number) => number;
}

export interface FitXTicksResult {
  /** The ticks to draw — a subset of the input, order kept, first and last included. */
  ticks: AxisTick[];
  /** `0` when flat, else the rotation in degrees (`text-anchor` end). */
  angle: number;
}

/**
 * Pick the x-axis labels that fit (Story MOTIR-8919). PURE — no DOM measurement,
 * so it is testable anywhere. The numbers are the design's (see `pageChart`):
 *
 * 1. Spacing between adjacent kept labels = estimated width of the widest label
 *    (chars × 6.3 px) + 12 px of clear space; keep every ⌈spacing ÷ pitch⌉-th
 *    tick from the first, where pitch is the smallest gap between two ticks.
 * 2. The first and the last tick are always kept; an earlier kept tick closer
 *    than the spacing to the last one is dropped instead.
 * 3. If fewer than 8 labels remain (and there were at least 8 to start with),
 *    angle them at −45° and re-thin at the angled spacing of 16 px.
 */
export function fitXTicks({ ticks, xScale }: FitXTicksInput): FitXTicksResult {
  const n = ticks.length;
  if (n <= 2) return { ticks, angle: 0 };
  const pos = ticks.map((t) => xScale(t.value));
  const widest = Math.max(...ticks.map((t) => t.label.length));
  const flatSpacing = widest * pageChart.labelCharWidth + pageChart.labelGap;

  const flat = thin(ticks, pos, flatSpacing);
  if (flat.length >= pageChart.minLabels || n < pageChart.minLabels) {
    return { ticks: flat, angle: 0 };
  }
  return { ticks: thin(ticks, pos, pageChart.angledSpacing), angle: pageChart.angle };
}

function thin(ticks: AxisTick[], pos: number[], spacing: number): AxisTick[] {
  const n = ticks.length;
  let pitch = Infinity;
  for (let i = 1; i < n; i++) {
    const gap = Math.abs(pos[i]! - pos[i - 1]!);
    if (gap > 0 && gap < pitch) pitch = gap;
  }
  if (!Number.isFinite(pitch)) return ticks;
  const step = Math.max(1, Math.ceil(spacing / pitch));
  const last = n - 1;
  const keep: number[] = [];
  for (let i = 0; i < n; i += step) {
    if (i === last || Math.abs(pos[last]! - pos[i]!) >= spacing) keep.push(i);
  }
  if (keep[keep.length - 1] !== last) keep.push(last);
  return keep.map((i) => ticks[i]!);
}
