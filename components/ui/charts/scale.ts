/**
 * Tiny, dependency-free charting math (Story 4.6.2).
 *
 * The repo ships NO charting library (Recharts / Chart.js / nivo) — they
 * carry their own canvas/DOM styling that bypasses the `--el-*` / shape-token
 * swap layer and pull ~80–120 kB for two charts (see `design/reports/
 * design-notes.md`). These helpers are the entire maths layer the SVG chart
 * primitives need: a linear scale, path builders for straight and step lines,
 * and a "nice" tick generator. No `d3`, no runtime deps.
 *
 * All functions are PURE (no DOM, no React) so they unit-test in isolation.
 */

/** A 1-D linear map from a data domain to a pixel range. */
export type Scale = (value: number) => number;

/** A point in data space (a `null` y is a gap — the series breaks there). */
export interface DataPoint {
  x: number;
  y: number | null;
}

/** A point in pixel space (always concrete). */
export interface PixelPoint {
  x: number;
  y: number;
}

/**
 * Build a linear scale mapping `domain` → `range`.
 *
 * For a Y axis pass an inverted range (`[bottom, top]`) so a larger data
 * value maps to a smaller pixel value (SVG y grows downward). A zero-width
 * domain is clamped to span 1 so the scale never divides by zero (it maps
 * everything to `range[0]`).
 */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value: number) => r0 + ((value - d0) / span) * (r1 - r0);
}

/**
 * An SVG path `d` for a straight poly-line through `points`.
 *
 * `null`-y points break the line into separate sub-paths (each `M`-started),
 * so a series with a gap renders as disconnected strokes rather than a line
 * dropping to the baseline.
 */
export function linePath(points: readonly PixelPoint[]): string {
  let d = '';
  let penDown = false;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      penDown = false;
      continue;
    }
    d += `${penDown ? 'L' : 'M'}${round(p.x)},${round(p.y)} `;
    penDown = true;
  }
  return d.trim();
}

/**
 * An SVG path `d` for a STEP line ("step-after"): the value holds across the
 * interval then changes at the next point's x. This is the burndown's actual
 * remaining line — flat while nothing burns, a vertical drop on the day an
 * issue reaches a done status, a vertical rise on a scope-add day.
 */
export function stepPath(points: readonly PixelPoint[]): string {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const first = pts[0];
  if (!first) return '';
  let d = `M${round(first.x)},${round(first.y)} `;
  let prevY = first.y;
  for (let i = 1; i < pts.length; i += 1) {
    const p = pts[i]!;
    // horizontal at the previous y, then vertical to the new y
    d += `L${round(p.x)},${round(prevY)} L${round(p.x)},${round(p.y)} `;
    prevY = p.y;
  }
  return d.trim();
}

/**
 * Close a line path into an area by dropping to `baselineY` under the first
 * and last x. Used for the optional area fill under a `LineChart` series.
 */
export function areaPath(
  linePathD: string,
  points: readonly PixelPoint[],
  baselineY: number,
): string {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last || !linePathD) return '';
  return `${linePathD} L${round(last.x)},${round(baselineY)} L${round(first.x)},${round(baselineY)} Z`;
}

/**
 * "Nice" evenly-spaced ticks from 0 up to a rounded ceiling that COVERS `max`,
 * with a human-friendly step (1/2/5 × 10ⁿ). Returns ascending values starting
 * at 0; the last tick is `>= max`. A non-positive or non-finite `max` yields
 * `[0]`. Hosts usually pass explicit ticks; this is the auto-axis convenience.
 */
export function niceTicks(max: number, targetCount = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0];
  const step = niceStep(max / Math.max(1, targetCount));
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) {
    ticks.push(Number(v.toFixed(6)));
  }
  return ticks;
}

/** The axis ceiling for data topping out at `max` — a nice value `>= max`. */
export function niceMax(max: number, targetCount = 4): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  const step = niceStep(max / Math.max(1, targetCount));
  return Math.ceil(max / step) * step;
}

/** Round a raw step up to the nearest 1/2/5 × 10ⁿ (Heckbert's nice-number). */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const niced = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return niced * mag;
}

/** Round to 2 dp and strip a trailing `.0` — keeps path strings compact. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
