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

/**
 * The READ-ONLY connector path between two node rects (world coords): leave A on
 * the side facing B and enter B on the side facing A, as a cubic bezier. The
 * dominant axis (horizontal vs vertical) picks the anchor sides, so a side-by-side
 * pair connects right→left and a stacked pair connects bottom→top — keeping the
 * dependency graph legible whatever arrangement the user drags the nodes into.
 */
export function edgePath(a: Rect, b: Rect): string {
  const acx = a.x + a.w / 2,
    acy = a.y + a.h / 2,
    bcx = b.x + b.w / 2,
    bcy = b.y + b.h / 2;
  const dx = bcx - acx,
    dy = bcy - acy;
  let ax: number, ay: number, bx: number, by: number;
  let c1x: number, c1y: number, c2x: number, c2y: number;
  if (Math.abs(dx) >= Math.abs(dy)) {
    // horizontal-dominant
    ax = dx > 0 ? a.x + a.w : a.x;
    bx = dx > 0 ? b.x : b.x + b.w;
    ay = acy;
    by = bcy;
    const mx = (ax + bx) / 2;
    c1x = mx;
    c1y = ay;
    c2x = mx;
    c2y = by;
  } else {
    // vertical-dominant
    ay = dy > 0 ? a.y + a.h : a.y;
    by = dy > 0 ? b.y : b.y + b.h;
    ax = acx;
    bx = bcx;
    const my = (ay + by) / 2;
    c1x = ax;
    c1y = my;
    c2x = bx;
    c2y = my;
  }
  return `M${ax},${ay} C${c1x},${c1y} ${c2x},${c2y} ${bx},${by}`;
}
