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

// Orthogonal routing constants. Every edge leaves its source on the RIGHT, rises
// into an overhead channel, runs across, and DROPS straight down into the target's
// TOP edge (arrow points down, lines turn at right angles). A GLOBAL lane pass then
// gives every edge its OWN exit height, rise lane, channel row and entry column, so
// no two segments lie on top of each other.
const EXIT_STUB = 22; // first horizontal stub off the source's right edge
const TOP_APPROACH = 34; // base height of the channel above the target top
const SLOT_STEP = 16; // spacing between sibling exit/entry/rise slots
const LANE_STEP = 16; // vertical spacing between overhead channel rows
const CORNER_R = 12; // rounded-corner radius at each turn
const MAX_LANE_BUMPS = 60; // safety cap on the greedy lane search

type Point = { x: number; y: number };

/** One placed connector: its SVG `d` string + a point ON it (for a between-edge
 *  badge such as the cross-story flag). */
export interface RoutedEdge {
  d: string;
  mid: Point;
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

/** Centre `n` slots inside `[start, start+size]` spaced `SLOT_STEP` apart, returning
 *  the `idx`-th (clamped to a margin) — spreads sibling exits/entries along an edge. */
function slotAt(start: number, size: number, idx: number, n: number): number {
  const margin = Math.min(size * 0.18, 20);
  const v = start + size / 2 - ((n - 1) * SLOT_STEP) / 2 + idx * SLOT_STEP;
  return Math.max(start + margin, Math.min(start + size - margin, v));
}

interface RouteItem {
  i: number;
  a: Rect;
  b: Rect;
  outIdx: number;
  outN: number;
  inIdx: number;
  inN: number;
  ax: number;
  exitY: number;
  riseX: number;
  entryX: number;
  bt: number;
  baseChY: number;
  xs: number;
  xe: number;
  chY: number;
}

/**
 * Route ALL the edges of a level at once and return one {@link RoutedEdge} per input
 * edge (aligned to `edges`; `null` where an endpoint rect is missing). Going global
 * is what lets the router hand every edge its own track:
 *  - sibling edges off one source get distinct exit heights + rise lanes;
 *  - sibling edges into one target get distinct entry columns;
 *  - the overhead horizontals are greedily assigned to channel rows so two whose
 *    x-spans overlap never share a row → no line is ever drawn on top of another.
 */
export function routeEdges(
  edges: ReadonlyArray<{ from: string; to: string }>,
  rect: (id: string) => Rect | undefined,
): Array<RoutedEdge | null> {
  const items: RouteItem[] = [];
  edges.forEach((e, i) => {
    const a = rect(e.from);
    const b = rect(e.to);
    if (a && b) {
      items.push({
        i,
        a,
        b,
        outIdx: 0,
        outN: 1,
        inIdx: 0,
        inN: 1,
        ax: 0,
        exitY: 0,
        riseX: 0,
        entryX: 0,
        bt: 0,
        baseChY: 0,
        xs: 0,
        xe: 0,
        chY: 0,
      });
    }
  });

  // sibling slots: out-edges per source (ordered by target), in-edges per target.
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
    arr.sort((p, q) => p.b.y - q.b.y || p.b.x - q.b.x);
    arr.forEach((it, k) => {
      it.outIdx = k;
      it.outN = arr.length;
    });
  }
  for (const arr of groupBy((it) => edges[it.i]!.to)) {
    arr.sort((p, q) => p.a.y - q.a.y || p.a.x - q.a.x);
    arr.forEach((it, k) => {
      it.inIdx = k;
      it.inN = arr.length;
    });
  }

  for (const it of items) {
    it.ax = it.a.x + it.a.w;
    it.exitY = slotAt(it.a.y, it.a.h, it.outIdx, it.outN);
    it.riseX = it.ax + EXIT_STUB + it.outIdx * SLOT_STEP;
    it.entryX = slotAt(it.b.x, it.b.w, it.inIdx, it.inN);
    it.bt = it.b.y;
    it.baseChY = Math.round((it.b.y - TOP_APPROACH) / LANE_STEP) * LANE_STEP; // global grid
    it.xs = Math.min(it.riseX, it.entryX) - 1;
    it.xe = Math.max(it.riseX, it.entryX) + 1;
  }

  // greedy channel-row assignment: bump a horizontal UP a lane until its x-span
  // clears every edge already placed on that exact row.
  const occupied = new Map<number, Array<[number, number]>>();
  for (const it of [...items].sort((p, q) => p.xs - q.xs)) {
    let k = 0;
    let y = it.baseChY;
    for (; k <= MAX_LANE_BUMPS; k++) {
      y = it.baseChY - k * LANE_STEP;
      const occ = occupied.get(y);
      if (!occ || !occ.some(([s, e]) => !(it.xe < s || it.xs > e))) {
        (occ ?? occupied.set(y, []).get(y)!).push([it.xs, it.xe]);
        break;
      }
    }
    it.chY = y;
  }

  const out: Array<RoutedEdge | null> = edges.map(() => null);
  for (const it of items) {
    const pts: Point[] = [
      { x: it.ax, y: it.exitY },
      { x: it.riseX, y: it.exitY },
      { x: it.riseX, y: it.chY },
      { x: it.entryX, y: it.chY },
      { x: it.entryX, y: it.bt },
    ];
    out[it.i] = {
      d: roundedPath(pts, CORNER_R),
      mid: { x: (it.riseX + it.entryX) / 2, y: it.chY },
    };
  }
  return out;
}
