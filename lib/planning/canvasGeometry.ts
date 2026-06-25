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

// Connector constants. An edge attaches to the SIDE of each card that faces the
// other card (so the arrowhead lands where the line actually arrives, never
// crossing the block) and is drawn as a smooth cubic that leaves/enters
// perpendicular to that side. Curves have no long straight runs, so connectors
// never stack on top of one another; siblings fan out along their shared side.
const CTRL_FRAC = 0.45; // control-point reach as a fraction of the anchor distance
const CTRL_MIN = 40;
const CTRL_MAX = 150;
const BOW_THRESHOLD = 420; // a horizontal edge longer than this starts to ARC…
const BOW_FRAC = 0.5; // …by this much per px beyond the threshold…
const BOW_MAX = 150; // …capped here, so it clears a card between the two columns.

type Point = { x: number; y: number };
type Side = 'left' | 'right' | 'top' | 'bottom';

/** One placed connector: its SVG `d` string + a point ON it (for a between-edge
 *  badge such as the cross-story flag). */
export interface RoutedEdge {
  d: string;
  mid: Point;
}

const round = (v: number): number => Math.round(v * 100) / 100;

const NORMALS: Record<Side, Point> = {
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

/** A point on `side` of `rect`, parameter `t` ∈ [0,1] along that side. */
function sideAnchor(r: Rect, side: Side, t: number): Point {
  if (side === 'right') return { x: r.x + r.w, y: r.y + r.h * t };
  if (side === 'left') return { x: r.x, y: r.y + r.h * t };
  if (side === 'top') return { x: r.x + r.w * t, y: r.y };
  return { x: r.x + r.w * t, y: r.y + r.h }; // bottom
}

/** Where the `idx`-th of `n` siblings sits along a side (a band in the middle 44%
 *  so several edges off/into one side fan out instead of stacking on one point). */
function slotT(idx: number, n: number): number {
  return n <= 1 ? 0.5 : 0.28 + 0.44 * (idx / (n - 1));
}

interface RouteItem {
  i: number;
  a: Rect;
  b: Rect;
  outIdx: number;
  outN: number;
  inIdx: number;
  inN: number;
}

/**
 * Route ALL the edges of a level at once and return one {@link RoutedEdge} per input
 * edge (aligned to `edges`; `null` where an endpoint rect is missing). Each edge
 * connects the two cards on the sides that FACE each other — by the dominant axis
 * between their centres: mostly right→left for the left→right flow, but left→right
 * for a back edge and bottom→top for a stacked pair — so the arrowhead always lands
 * on the side the line arrives from. Siblings off one source (or into one target)
 * fan along that shared side. A horizontal edge spanning more than a neighbour ARCS
 * so it clears any card between the columns rather than hiding behind it.
 */
export function routeEdges(
  edges: ReadonlyArray<{ from: string; to: string }>,
  rect: (id: string) => Rect | undefined,
): Array<RoutedEdge | null> {
  const items: RouteItem[] = [];
  edges.forEach((e, i) => {
    const a = rect(e.from);
    const b = rect(e.to);
    if (a && b) items.push({ i, a, b, outIdx: 0, outN: 1, inIdx: 0, inN: 1 });
  });

  // sibling slots: out-edges per source (ordered by the target they head to), and
  // in-edges per target (ordered by the source they come from) — a stable fan order.
  const cy = (r: Rect): number => r.y + r.h / 2;
  const groupBy = (pick: (it: RouteItem) => string): RouteItem[][] => {
    const m = new Map<string, RouteItem[]>();
    for (const it of items) {
      const k = pick(it);
      const arr = m.get(k);
      if (arr) arr.push(it);
      else m.set(k, [it]);
    }
    return [...m.values()];
  };
  for (const arr of groupBy((it) => edges[it.i]!.from)) {
    arr.sort((p, q) => cy(p.b) - cy(q.b) || p.b.x - q.b.x);
    arr.forEach((it, k) => {
      it.outIdx = k;
      it.outN = arr.length;
    });
  }
  for (const arr of groupBy((it) => edges[it.i]!.to)) {
    arr.sort((p, q) => cy(p.a) - cy(q.a) || p.a.x - q.a.x);
    arr.forEach((it, k) => {
      it.inIdx = k;
      it.inN = arr.length;
    });
  }

  const out: Array<RoutedEdge | null> = edges.map(() => null);
  for (const it of items) {
    const { a, b } = it;
    const scx = a.x + a.w / 2;
    const scy = a.y + a.h / 2;
    const tcx = b.x + b.w / 2;
    const tcy = b.y + b.h / 2;
    const dx = tcx - scx;
    const dy = tcy - scy;
    let exitSide: Side;
    let entrySide: Side;
    if (Math.abs(dx) >= Math.abs(dy)) {
      exitSide = dx >= 0 ? 'right' : 'left';
      entrySide = dx >= 0 ? 'left' : 'right';
    } else {
      exitSide = dy >= 0 ? 'bottom' : 'top';
      entrySide = dy >= 0 ? 'top' : 'bottom';
    }
    const A = sideAnchor(a, exitSide, slotT(it.outIdx, it.outN));
    const B = sideAnchor(b, entrySide, slotT(it.inIdx, it.inN));
    const en = NORMALS[exitSide];
    const xn = NORMALS[entrySide];
    const k = Math.max(CTRL_MIN, Math.min(CTRL_MAX, Math.hypot(B.x - A.x, B.y - A.y) * CTRL_FRAC));
    const c1 = { x: A.x + en.x * k, y: A.y + en.y * k };
    const c2 = { x: B.x + xn.x * k, y: B.y + xn.y * k };
    if (exitSide === 'left' || exitSide === 'right') {
      // long horizontal edge → arc away from the lower endpoint to clear a card
      // sitting between the columns.
      const bow = Math.min(Math.max((Math.abs(dx) - BOW_THRESHOLD) * BOW_FRAC, 0), BOW_MAX);
      const dir = scy <= tcy ? -1 : 1;
      c1.y += dir * bow;
      c2.y += dir * bow;
    }
    // the cubic point at t=0.5 — a stable spot ON the curve for a between-edge badge.
    const mid = {
      x: 0.125 * A.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * B.x,
      y: 0.125 * A.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * B.y,
    };
    out[it.i] = {
      d: `M${round(A.x)},${round(A.y)} C${round(c1.x)},${round(c1.y)} ${round(c2.x)},${round(c2.y)} ${round(B.x)},${round(B.y)}`,
      mid,
    };
  }
  return out;
}
