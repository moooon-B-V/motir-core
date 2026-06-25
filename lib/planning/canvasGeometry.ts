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

/** A world-space point ON the connector route (anchors a between-edge badge, so a
 *  cross-story flag rests on the line a reader sees) — the middle of the overhead
 *  channel the route runs across. */
export function edgeMidpoint(a: Rect, b: Rect): { x: number; y: number } {
  const pts = routePoints(a, b);
  const p = pts[2]!;
  const q = pts[3]!;
  return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
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

// Orthogonal routing constants. Leave the source on its right; rise into a channel
// just above the target; run across; DROP straight down into the target's TOP edge
// (so the arrowhead points down into the card and the line turns at right angles).
const EXIT_STUB = 26; // short horizontal stub off the source before the first turn
const TOP_APPROACH = 40; // height of the channel above the target's top edge
const CORNER_R = 16; // rounded-corner radius at each turn
const SPREAD_FRAC = 0.06; // entry fan across the target top (per source offset)
const SPREAD_MAX_FRAC = 0.3; // … capped to ±30% of the target width

type Point = { x: number; y: number };

/**
 * The orthogonal waypoints of the connector A→B: source right-centre → a short
 * stub → up/down into a channel above the target → across → straight DOWN into the
 * target's TOP edge. The top-entry x is fanned toward the source so several edges
 * into one card land at DISTINCT points rather than merging at dead-centre.
 */
function routePoints(a: Rect, b: Rect): Point[] {
  const ax = a.x + a.w; // source right edge
  const ay = a.y + a.h / 2; // … centre height
  const bcx = b.x + b.w / 2; // target centre x
  const bt = b.y; // target top edge
  const cap = b.w * SPREAD_MAX_FRAC;
  const spread = Math.max(-cap, Math.min(cap, (ax - bcx) * SPREAD_FRAC));
  const bx = bcx + spread;
  const chY = bt - TOP_APPROACH; // overhead channel just above the target top
  return [
    { x: ax, y: ay },
    { x: ax + EXIT_STUB, y: ay },
    { x: ax + EXIT_STUB, y: chY },
    { x: bx, y: chY },
    { x: bx, y: bt },
  ];
}

const round = (v: number): number => Math.round(v * 100) / 100;
const fmt = (p: Point): string => `${round(p.x)},${round(p.y)}`;

/** An SVG `d` string through `pts` with rounded corners of radius `r`. */
function roundedPath(pts: Point[], r: number): string {
  if (pts.length < 2) return '';
  const d = [`M${fmt(pts[0]!)}`];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const ab = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const bc = Math.hypot(c.x - b.x, c.y - b.y) || 1;
    const r1 = Math.min(r, ab / 2);
    const r2 = Math.min(r, bc / 2);
    const p1 = { x: b.x + ((a.x - b.x) / ab) * r1, y: b.y + ((a.y - b.y) / ab) * r1 };
    const p2 = { x: b.x + ((c.x - b.x) / bc) * r2, y: b.y + ((c.y - b.y) / bc) * r2 };
    d.push(`L${fmt(p1)}`, `Q${fmt(b)} ${fmt(p2)}`);
  }
  d.push(`L${fmt(pts[pts.length - 1]!)}`);
  return d.join(' ');
}

/**
 * The READ-ONLY connector PATH (an SVG `d` string) between two node rects — an
 * orthogonal route that turns at right angles and enters the target on its TOP
 * edge (see `routePoints`). Same input → same path; works for any arrangement the
 * user drags the nodes into.
 */
export function edgePath(a: Rect, b: Rect): string {
  return roundedPath(routePoints(a, b), CORNER_R);
}
