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

// Orthogonal routing constants. Every edge leaves its source on the RIGHT and
// enters its target on the LEFT (so the arrow follows the left→right flow); the
// turns are right angles. A neighbour edge is a clean S-elbow through the gutter
// between the two columns; a longer/back edge detours through a TOP band. A GLOBAL
// lane pass then keeps BOTH axes apart: every VERTICAL in a column gutter gets its
// own x-lane, every band HORIZONTAL its own y-lane, and sibling exits/entries their
// own slot — so no segment is ever drawn on top of another.
const SLOT_STEP = 13; // spacing between sibling exit/entry slots on a node edge
const BAND_LANE_STEP = 16; // vertical spacing between top-band rows
const BAND_RISE = 18; // stub before a band edge turns up out of its source
const BAND_GAP_ABOVE = 50; // the first band sits this far above the topmost node
const CORNER_R = 10; // rounded-corner radius at each turn

type Point = { x: number; y: number };

/** One placed connector: its SVG `d` string + a point ON it (for a between-edge
 *  badge such as the cross-story flag). */
export interface RoutedEdge {
  d: string;
  mid: Point;
}

const round = (v: number): number => Math.round(v * 100) / 100;
const fmt = (p: Point): string => `${round(p.x)},${round(p.y)}`;

/** An SVG `d` string through `pts` (collapsing repeats) with rounded corners. */
function roundedPath(pts: Point[], r: number): string {
  const u: Point[] = [];
  for (const p of pts) {
    const last = u[u.length - 1];
    if (!last || Math.abs(p.x - last.x) > 0.01 || Math.abs(p.y - last.y) > 0.01) u.push(p);
  }
  if (u.length < 2) return `M${fmt(u[0] ?? pts[0]!)}`;
  const d = [`M${fmt(u[0]!)}`];
  for (let i = 1; i < u.length - 1; i++) {
    const a = u[i - 1]!;
    const b = u[i]!;
    const c = u[i + 1]!;
    const ab = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const bc = Math.hypot(c.x - b.x, c.y - b.y) || 1;
    const r1 = Math.min(r, ab / 2);
    const r2 = Math.min(r, bc / 2);
    const p1 = { x: b.x + ((a.x - b.x) / ab) * r1, y: b.y + ((a.y - b.y) / ab) * r1 };
    const p2 = { x: b.x + ((c.x - b.x) / bc) * r2, y: b.y + ((c.y - b.y) / bc) * r2 };
    d.push(`L${fmt(p1)}`, `Q${fmt(b)} ${fmt(p2)}`);
  }
  d.push(`L${fmt(u[u.length - 1]!)}`);
  return d.join(' ');
}

/** Centre `n` slots inside `[start, start+size]` spaced `SLOT_STEP` apart, returning
 *  the `idx`-th (clamped to a margin) — spreads sibling exits/entries along an edge. */
function slotAt(start: number, size: number, idx: number, n: number): number {
  const margin = Math.min(size * 0.16, 18);
  const v = start + size / 2 - ((n - 1) * SLOT_STEP) / 2 + idx * SLOT_STEP;
  return Math.max(start + margin, Math.min(start + size - margin, v));
}

/** Greedy interval colouring: assign each item the lowest lane index whose members'
 *  spans (from `span`) do not overlap it — so two overlapping spans never coincide. */
function assignLanes<T>(items: T[], span: (t: T) => [number, number]): Map<T, number> {
  const lanes: Array<Array<[number, number]>> = [];
  const idx = new Map<T, number>();
  for (const it of [...items].sort((p, q) => span(p)[0] - span(q)[0])) {
    const [lo, hi] = span(it);
    let k = 0;
    for (; k < lanes.length; k++) if (!lanes[k]!.some(([s, e]) => !(hi < s || lo > e))) break;
    if (k === lanes.length) lanes.push([]);
    lanes[k]!.push([lo, hi]);
    idx.set(it, k);
  }
  return idx;
}

interface RouteItem {
  i: number;
  a: Rect;
  b: Rect;
  outIdx: number;
  outN: number;
  inIdx: number;
  inN: number;
  sR: number;
  tL: number;
  exitY: number;
  entryY: number;
  cs: number;
  ct: number;
  adjacent: boolean;
  bandY: number;
  vlaneX: number;
}

/**
 * Route ALL the edges of a level at once and return one {@link RoutedEdge} per input
 * edge (aligned to `edges`; `null` where an endpoint rect is missing). Routing the
 * whole level together is what lets it keep every connector on its own track:
 *  - sibling edges off one source get distinct exit heights; into one target,
 *    distinct entry heights (no two arrowheads coincide);
 *  - every VERTICAL run lives in the gutter just left of its target column and is
 *    greedily assigned an x-lane there, so two verticals never share an x;
 *  - a longer/back edge's long HORIZONTAL runs in a top band, greedily assigned a
 *    y-lane, so two band runs never share a y.
 * The result: no segment is ever drawn on top of another, on either axis.
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
        sR: 0,
        tL: 0,
        exitY: 0,
        entryY: 0,
        cs: 0,
        ct: 0,
        adjacent: false,
        bandY: 0,
        vlaneX: 0,
      });
    }
  });
  if (items.length === 0) return edges.map(() => null);

  // columns = the distinct node-x values, left→right; a node's column is its x rank.
  const xs = [...new Set(items.flatMap((it) => [it.a.x, it.b.x]))].sort((p, q) => p - q);
  const colOf = (x: number): number => xs.indexOf(x);
  const colRight = new Map<number, number>();
  for (const it of items) {
    for (const r of [it.a, it.b]) {
      const c = colOf(r.x);
      colRight.set(c, Math.max(colRight.get(c) ?? -Infinity, r.x + r.w));
    }
  }
  const minTop = Math.min(...items.flatMap((it) => [it.a.y, it.b.y]));

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
    it.sR = it.a.x + it.a.w;
    it.tL = it.b.x;
    it.exitY = slotAt(it.a.y, it.a.h, it.outIdx, it.outN);
    it.entryY = slotAt(it.b.y, it.b.h, it.inIdx, it.inN);
    it.cs = colOf(it.a.x);
    it.ct = colOf(it.b.x);
    it.adjacent = it.ct === it.cs + 1;
  }

  // top-band y-lanes for the long/back (non-adjacent) edges, by horizontal x-span.
  const band = items.filter((it) => !it.adjacent);
  const bandLane = assignLanes(band, (it) => [
    Math.min(it.sR, it.tL) - 1,
    Math.max(it.sR, it.tL) + 1,
  ]);
  for (const it of band)
    it.bandY = minTop - BAND_GAP_ABOVE - (bandLane.get(it) ?? 0) * BAND_LANE_STEP;

  // gutter x-lanes: EVERY edge's vertical run lives in the gutter just left of its
  // target column; lane them together (per gutter) by y-span so none coincide.
  const byGutter = new Map<number, RouteItem[]>();
  for (const it of items) {
    const arr = byGutter.get(it.ct);
    if (arr) arr.push(it);
    else byGutter.set(it.ct, [it]);
  }
  for (const [ct, arr] of byGutter) {
    const lane = assignLanes(arr, (it) => {
      const a = it.adjacent ? it.exitY : it.bandY;
      return [Math.min(a, it.entryY), Math.max(a, it.entryY)];
    });
    const k = Math.max(...arr.map((it) => lane.get(it) ?? 0)) + 1;
    const gutterRight = xs[ct]!;
    const gutterLeft = ct > 0 ? (colRight.get(ct - 1) ?? gutterRight - 60) : gutterRight - 60;
    const width = Math.max(24, gutterRight - gutterLeft);
    for (const it of arr) it.vlaneX = gutterLeft + (width * ((lane.get(it) ?? 0) + 1)) / (k + 1);
  }

  const out: Array<RoutedEdge | null> = edges.map(() => null);
  for (const it of items) {
    let pts: Point[];
    let mid: Point;
    if (it.adjacent) {
      // clean S-elbow through the single gutter: right → down/up the lane → left.
      pts = [
        { x: it.sR, y: it.exitY },
        { x: it.vlaneX, y: it.exitY },
        { x: it.vlaneX, y: it.entryY },
        { x: it.tL, y: it.entryY },
      ];
      mid = { x: it.vlaneX, y: (it.exitY + it.entryY) / 2 };
    } else {
      // detour over a top band: right → up to the band → across → down the target
      // gutter lane → into the target's left.
      pts = [
        { x: it.sR, y: it.exitY },
        { x: it.sR + BAND_RISE, y: it.exitY },
        { x: it.sR + BAND_RISE, y: it.bandY },
        { x: it.vlaneX, y: it.bandY },
        { x: it.vlaneX, y: it.entryY },
        { x: it.tL, y: it.entryY },
      ];
      mid = { x: (it.sR + BAND_RISE + it.vlaneX) / 2, y: it.bandY };
    }
    out[it.i] = { d: roundedPath(pts, CORNER_R), mid };
  }
  return out;
}
