/**
 * Donut + difference-area geometry (Story 6.3.4) — the pure maths for the two
 * chart forms Story 6.3 grows inside the 4.6.2 token-aware SVG layer (no d3,
 * no charting library, the recorded 4.6 decision).
 *
 * Every function is PURE (no DOM, no React, no token lookups) so it unit-tests
 * in isolation exactly like `scale.ts`: the donut consumes only `(value)` data
 * and a geometry box, the difference helper only `(x, y)` series in DATA space.
 * Colour is layered on by the components (the `--el-chart-*` ramp) — geometry
 * returns a `colorIndex` / `neutral` flag, never a token string.
 */

/** A point in DATA space with a concrete y (no gaps in these two forms). */
export interface XYPoint {
  x: number;
  y: number;
}

/** A point in SVG pixel space. */
export interface PixelPoint {
  x: number;
  y: number;
}

// ── Donut ──────────────────────────────────────────────────────────────────

/** One datum feeding the distribution donut. */
export interface DonutInput {
  label: string;
  value: number;
  /**
   * The "None" / unset group — pinned to the neutral grey and kept out of the
   * ramp + the overflow rollup, always rendered last (the Jira behaviour).
   */
  none?: boolean;
}

/** Where + how big the annulus is, in the SVG's own coordinate space. */
export interface DonutGeometry {
  cx: number;
  cy: number;
  outerR: number;
  innerR: number;
}

/** A laid-out donut wedge — the geometry + the data it re-expresses. */
export interface DonutSegment {
  label: string;
  value: number;
  /** Share of the total, 0..100. */
  percentage: number;
  /**
   * Index into the categorical ramp (0-based), or `-1` for a neutral wedge
   * (the None group and the aggregated "+N more" overflow rollup).
   */
  colorIndex: number;
  /** True for the None group AND the "+N more" rollup — both render neutral grey. */
  neutral: boolean;
  /** Degrees, clockwise from the top (12 o'clock). */
  startAngle: number;
  endAngle: number;
  /** The SVG annular-wedge path `d` (render with `fill-rule="evenodd"`). */
  path: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * A point on a circle at `angleDeg` measured CLOCKWISE from the top (12
 * o'clock). SVG y grows downward, so clockwise is `+sin` on x and `−cos` on y:
 * 0° → top, 90° → right, 180° → bottom, 270° → left.
 */
export function pointOnCircle(cx: number, cy: number, r: number, angleDeg: number): PixelPoint {
  const a = (angleDeg * Math.PI) / 180;
  return { x: round2(cx + r * Math.sin(a)), y: round2(cy - r * Math.cos(a)) };
}

/**
 * The SVG path `d` for ONE annular wedge from `startAngle` to `endAngle`
 * (clockwise from top): out along the start radius, the outer arc clockwise,
 * in to the inner radius, the inner arc counter-clockwise back, close. The
 * large-arc flag is set once the wedge spans more than 180°. A wedge that
 * covers the whole circle can't be a single arc (start == end), so it falls
 * back to a two-circle ring punched by `fill-rule="evenodd"`.
 */
export function annularWedgePath(geo: DonutGeometry, startAngle: number, endAngle: number): string {
  const { cx, cy, outerR, innerR } = geo;
  const sweep = endAngle - startAngle;
  if (sweep >= 359.999) return fullRingPath(geo);
  const oS = pointOnCircle(cx, cy, outerR, startAngle);
  const oE = pointOnCircle(cx, cy, outerR, endAngle);
  const iE = pointOnCircle(cx, cy, innerR, endAngle);
  const iS = pointOnCircle(cx, cy, innerR, startAngle);
  const large = sweep > 180 ? 1 : 0;
  return (
    `M${oS.x},${oS.y} A${outerR} ${outerR} 0 ${large} 1 ${oE.x},${oE.y} ` +
    `L${iE.x},${iE.y} A${innerR} ${innerR} 0 ${large} 0 ${iS.x},${iS.y} Z`
  );
}

/** A full ring (single 100% group): two concentric circles, hole via even-odd. */
function fullRingPath({ cx, cy, outerR, innerR }: DonutGeometry): string {
  const ring = (r: number): string =>
    `M${round2(cx)},${round2(cy - r)} A${r} ${r} 0 1 1 ${round2(cx)},${round2(cy + r)} ` +
    `A${r} ${r} 0 1 1 ${round2(cx)},${round2(cy - r)} Z`;
  return `${ring(outerR)} ${ring(innerR)}`;
}

/**
 * Lay out the donut wedges, clockwise from the top, applying the categorical
 * ramp + the overflow + None rules (design-notes 6.3.3):
 *  - non-None segments take ramp slots `0..rampLength-1` in order;
 *  - beyond `rampLength` the ramp would repeat, so the tail is rolled into ONE
 *    neutral "+N more" wedge (never indistinguishable repeats);
 *  - the None group(s) aggregate into ONE neutral wedge, always last.
 * Returns `[]` for non-positive data so the caller renders the empty state
 * (never `NaN` geometry).
 */
export function donutSegments(
  data: DonutInput[],
  geo: DonutGeometry,
  options?: { rampLength?: number },
): DonutSegment[] {
  const rampLength = options?.rampLength ?? 7;
  const cleaned = data
    .map((d) => ({ ...d, value: Math.max(0, d.value) }))
    .filter((d) => d.value > 0);
  const total = cleaned.reduce((s, d) => s + d.value, 0);
  if (total <= 0) return [];

  const noneItems = cleaned.filter((d) => d.none);
  const ramp = cleaned.filter((d) => !d.none);
  const noneValue = noneItems.reduce((s, d) => s + d.value, 0);

  type Entry = { label: string; value: number; colorIndex: number; neutral: boolean };
  const entries: Entry[] = [];

  if (ramp.length <= rampLength) {
    ramp.forEach((d, i) =>
      entries.push({ label: d.label, value: d.value, colorIndex: i, neutral: false }),
    );
  } else {
    // Keep rampLength-1 distinct hues, roll the rest into one neutral wedge.
    const keep = rampLength - 1;
    ramp
      .slice(0, keep)
      .forEach((d, i) =>
        entries.push({ label: d.label, value: d.value, colorIndex: i, neutral: false }),
      );
    const tail = ramp.slice(keep);
    entries.push({
      label: `+${tail.length} more`,
      value: tail.reduce((s, d) => s + d.value, 0),
      colorIndex: -1,
      neutral: true,
    });
  }

  if (noneValue > 0) {
    entries.push({
      label: noneItems.length === 1 ? noneItems[0]!.label : 'None',
      value: noneValue,
      colorIndex: -1,
      neutral: true,
    });
  }

  let angle = 0;
  return entries.map((e) => {
    const start = angle;
    const end = angle + (e.value / total) * 360;
    angle = end;
    return {
      label: e.label,
      value: e.value,
      percentage: (e.value / total) * 100,
      colorIndex: e.colorIndex,
      neutral: e.neutral,
      startAngle: start,
      endAngle: end,
      path: annularWedgePath(geo, start, end),
    };
  });
}

// ── Difference / area ────────────────────────────────────────────────────────

/** A shaded band between the created + resolved lines over one (or part) bucket. */
export interface DiffBand {
  /** `deficit` = created above resolved (backlog growing); `surplus` = the reverse. */
  kind: 'deficit' | 'surplus';
  /** The band polygon in DATA space (the caller scales it to pixels). */
  polygon: XYPoint[];
}

/**
 * Segment the area between the `created` and `resolved` series into shaded
 * bands, split at every crossover (design-notes 6.3.3). The two series are
 * sampled at the SAME bucket x's (aligned by index). For each bucket interval:
 *  - if one series stays above the other across the whole interval, the band
 *    is one trapezoid (`deficit` if created is the higher VALUE, else `surplus`);
 *  - if they cross, the interval splits at the crossover into two triangles,
 *    one of each kind.
 * Operates in DATA space and is pure, so it unit-tests independently of the
 * pixel scales. A coincident interval (the lines touch throughout) yields no band.
 */
export function differenceBands(created: XYPoint[], resolved: XYPoint[]): DiffBand[] {
  const n = Math.min(created.length, resolved.length);
  const bands: DiffBand[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const c0 = created[i]!;
    const c1 = created[i + 1]!;
    const r0 = resolved[i]!;
    const r1 = resolved[i + 1]!;
    const d0 = c0.y - r0.y; // > 0 ⇒ created value above resolved ⇒ deficit
    const d1 = c1.y - r1.y;
    if (d0 === 0 && d1 === 0) continue; // coincident — no area

    const sameSide = (d0 >= 0 && d1 >= 0) || (d0 <= 0 && d1 <= 0);
    if (sameSide) {
      const kind: DiffBand['kind'] = d0 + d1 >= 0 ? 'deficit' : 'surplus';
      bands.push({ kind, polygon: [c0, c1, r1, r0] });
      continue;
    }

    // Crossover at t ∈ (0,1): d0 + t·(d1 − d0) = 0 ⇒ t = d0 / (d0 − d1).
    const t = d0 / (d0 - d1);
    const cross: XYPoint = {
      x: c0.x + t * (c1.x - c0.x),
      y: c0.y + t * (c1.y - c0.y), // equals the resolved interpolation at t
    };
    bands.push({ kind: d0 >= 0 ? 'deficit' : 'surplus', polygon: [c0, cross, r0] });
    bands.push({ kind: d1 >= 0 ? 'deficit' : 'surplus', polygon: [cross, c1, r1] });
  }
  return bands;
}

/** An SVG `d` for a closed polygon through `points` (pixel space). */
export function polygonPath(points: readonly PixelPoint[]): string {
  if (points.length === 0) return '';
  return `${points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round2(p.x)},${round2(p.y)}`).join(' ')} Z`;
}
