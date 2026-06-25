// Pure geometry for the spatial planning canvas (Subtask 7.3.76 / MOTIR-1236).
// The interaction MATH — pan/zoom transforms, fit-to-view, and the read-only edge
// connector path — kept free of React/DOM so it is exhaustively unit-testable; the
// `PlanningCanvas` component owns the pointer/wheel I/O and calls these.
//
// The world→screen transform is `screen = t + world * scale` (a translate then a
// uniform scale, matching the CSS `translate(tx,ty) scale(s)` on the world layer).

/** The canvas viewport transform: a uniform scale + a translation (screen px). */
export interface View {
  scale: number;
  tx: number;
  ty: number;
}

/** A node's box in WORLD coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Zoom is bounded so a node can never vanish to a point or fill the screen.
export const MIN_SCALE = 0.3;
export const MAX_SCALE = 2;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Zoom by `factor`, keeping the WORLD point currently under the screen anchor
 * (`cx`, `cy`) fixed — so a wheel-zoom homes on the cursor and a button-zoom homes
 * on the viewport centre. Scale is clamped; when it clamps, the anchor still holds
 * (`k` uses the clamped result).
 */
export function zoomToward(view: View, factor: number, cx: number, cy: number): View {
  const scale = clampScale(view.scale * factor);
  const k = scale / view.scale;
  return {
    scale,
    tx: cx - (cx - view.tx) * k,
    ty: cy - (cy - view.ty) * k,
  };
}

/** The axis-aligned bounding box of node rects (zeroed for an empty set). */
export function nodesBounds(rects: Rect[]): Bounds {
  if (rects.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The view that fits `bounds` into a `viewport` (screen px) with `padding`,
 * centred. Scale is clamped to the zoom range; the translation centres the bounds
 * within the viewport at the chosen scale.
 */
export function fitView(bounds: Bounds, viewport: { w: number; h: number }, padding = 48): View {
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  const sx = (viewport.w - padding * 2) / bw;
  const sy = (viewport.h - padding * 2) / bh;
  const scale = clampScale(Math.min(sx, sy));
  return {
    scale,
    tx: (viewport.w - bw * scale) / 2 - bounds.minX * scale,
    ty: (viewport.h - bh * scale) / 2 - bounds.minY * scale,
  };
}

/**
 * The view that CENTRES a single world `rect` in the `viewport` at the current
 * `scale` (the scale is left untouched — a pan, not a zoom). Used by
 * search-to-focus: locate a node, then pan it to the middle of the screen.
 */
export function centerOn(rect: Rect, viewport: { w: number; h: number }, scale: number): View {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return { scale, tx: viewport.w / 2 - cx * scale, ty: viewport.h / 2 - cy * scale };
}

/** The world-space midpoint ON the connector curve (anchors a between-edge badge,
 *  so a cross-story flag rests on the line a reader sees, not on the chord). */
export function edgeMidpoint(a: Rect, b: Rect): { x: number; y: number } {
  const c = edgeCurve(a, b);
  // the cubic evaluated at t=0.5
  return {
    x: 0.125 * c.ax + 0.375 * c.c1x + 0.375 * c.c2x + 0.125 * c.bx,
    y: 0.125 * c.ay + 0.375 * c.c1y + 0.375 * c.c2y + 0.125 * c.by,
  };
}

/** Convert a SCREEN delta (px) to a WORLD delta — used when dragging a node. */
export function screenDeltaToWorld(
  dx: number,
  dy: number,
  scale: number,
): { dx: number; dy: number } {
  return { dx: dx / scale, dy: dy / scale };
}

/** Map a screen point to the world point under it (inverse of the view transform). */
export function screenToWorld(view: View, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale };
}

/** Where the ray from rect centre toward `(tx, ty)` crosses the rect border — the
 *  edge ANCHOR. Anchoring on the true line of sight (not a fixed mid-side point)
 *  makes the connector point AT the other node and lets several edges off one node
 *  fan out from distinct border points instead of stacking on one side. */
function borderPoint(r: Rect, tx: number, ty: number): { x: number; y: number } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? r.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? r.h / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  return { x: cx + dx * t, y: cy + dy * t };
}

interface EdgeCurve {
  ax: number;
  ay: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  bx: number;
  by: number;
}

// Control-point reach along the line, and a perpendicular BOW that grows with
// length (capped) so a long skip edge ARCS over the node it would otherwise pass
// behind, while a short neighbour edge stays nearly straight.
const CTRL_FRAC = 0.42;
const CTRL_MAX = 130;
const BOW_FRAC = 0.22;
const BOW_MAX = 110;

/**
 * The cubic connector between two node rects (world coords): anchored at each
 * border on the line of sight to the other node, with control points reaching
 * ALONG that line (so the END tangent follows the line and the arrowhead points
 * the way the edge actually travels) plus a gentle perpendicular bow (so a long
 * skip edge arcs clear of an intermediate node and parallel edges separate).
 */
function edgeCurve(a: Rect, b: Rect): EdgeCurve {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  const A = borderPoint(a, bcx, bcy);
  const B = borderPoint(b, acx, acy);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const k = Math.min(len * CTRL_FRAC, CTRL_MAX);
  const bow = Math.min(len * BOW_FRAC, BOW_MAX);
  const px = uy; // left normal of the travel direction
  const py = -ux;
  return {
    ax: A.x,
    ay: A.y,
    c1x: A.x + ux * k + px * bow,
    c1y: A.y + uy * k + py * bow,
    c2x: B.x - ux * k + px * bow,
    c2y: B.y - uy * k + py * bow,
    bx: B.x,
    by: B.y,
  };
}

const round = (v: number): number => Math.round(v * 100) / 100;

/**
 * The READ-ONLY connector PATH (an SVG `d` string) between two node rects — a
 * direction-following cubic (see `edgeCurve`). Same input → same path; works for
 * any arrangement the user drags the nodes into.
 */
export function edgePath(a: Rect, b: Rect): string {
  const c = edgeCurve(a, b);
  return `M${round(c.ax)},${round(c.ay)} C${round(c.c1x)},${round(c.c1y)} ${round(c.c2x)},${round(c.c2y)} ${round(c.bx)},${round(c.by)}`;
}
