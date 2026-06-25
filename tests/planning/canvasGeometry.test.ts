import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  centerOn,
  clampScale,
  fitView,
  nodesBounds,
  routeEdges,
  screenDeltaToWorld,
  screenToWorld,
  zoomToward,
} from '@/lib/planning/canvasGeometry';

describe('centerOn', () => {
  it('pans a node to the viewport centre, preserving scale', () => {
    const rect = { x: 100, y: 200, w: 280, h: 132 };
    const viewport = { w: 1000, h: 600 };
    const v = centerOn(rect, viewport, 1.5);
    expect(v.scale).toBe(1.5);
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    expect(v.tx + cx * v.scale).toBeCloseTo(viewport.w / 2);
    expect(v.ty + cy * v.scale).toBeCloseTo(viewport.h / 2);
  });
});

describe('clampScale', () => {
  it('bounds the zoom range', () => {
    expect(clampScale(5)).toBe(MAX_SCALE);
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(1)).toBe(1);
  });
});

describe('zoomToward', () => {
  it('keeps the world point under the anchor fixed', () => {
    const v = { scale: 1, tx: 100, ty: 50 };
    const cx = 300;
    const cy = 200;
    const before = screenToWorld(v, cx, cy);
    const z = zoomToward(v, 1.5, cx, cy);
    const after = screenToWorld(z, cx, cy);
    expect(z.scale).toBeCloseTo(1.5);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('clamps to the zoom bounds (anchor still respected)', () => {
    expect(zoomToward({ scale: 1.8, tx: 0, ty: 0 }, 2, 0, 0).scale).toBe(MAX_SCALE);
    expect(zoomToward({ scale: 0.35, tx: 0, ty: 0 }, 0.5, 0, 0).scale).toBe(MIN_SCALE);
  });
});

describe('nodesBounds', () => {
  it('computes the bounding box of node rects', () => {
    expect(
      nodesBounds([
        { x: 10, y: 20, w: 100, h: 50 },
        { x: 200, y: 5, w: 80, h: 40 },
      ]),
    ).toEqual({ minX: 10, minY: 5, maxX: 280, maxY: 70 });
  });

  it('zeroes an empty set', () => {
    expect(nodesBounds([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe('fitView', () => {
  it('scales + centres the bounds into the viewport', () => {
    const v = fitView({ minX: 0, minY: 0, maxX: 1000, maxY: 500 }, { w: 940, h: 760 }, 20);
    // scale = min((940-40)/1000, (760-40)/500) = min(0.9, 1.44) = 0.9
    expect(v.scale).toBeCloseTo(0.9);
    expect(v.tx).toBeCloseTo((940 - 1000 * 0.9) / 2); // 20
    expect(v.ty).toBeCloseTo((760 - 500 * 0.9) / 2); // 155
  });

  it('clamps the fit scale to the zoom max for a tiny graph', () => {
    expect(fitView({ minX: 0, minY: 0, maxX: 20, maxY: 20 }, { w: 940, h: 760 }).scale).toBe(
      MAX_SCALE,
    );
  });
});

describe('screenDeltaToWorld / screenToWorld', () => {
  it('converts a screen drag delta to world units', () => {
    expect(screenDeltaToWorld(100, 50, 2)).toEqual({ dx: 50, dy: 25 });
  });
  it('inverts the view transform', () => {
    expect(screenToWorld({ scale: 2, tx: 100, ty: 40 }, 300, 240)).toEqual({ x: 100, y: 100 });
  });
});

// Parse an SVG `d` string into the ordered coordinate pairs it names (M/L
// endpoints and Q control+end points), so we can assert route geometry.
function points(d: string): Array<{ x: number; y: number }> {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i]!, y: nums[i + 1]! });
  return pts;
}

type RMap = Record<string, { x: number; y: number; w: number; h: number }>;
const lookup =
  (m: RMap) =>
  (id: string): RMap[string] | undefined =>
    m[id];

describe('routeEdges', () => {
  it('returns one route per edge (aligned to input), null when an endpoint is missing', () => {
    const m: RMap = { A: { x: 0, y: 0, w: 100, h: 50 }, B: { x: 300, y: 0, w: 100, h: 50 } };
    const r = routeEdges(
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'GONE' },
      ],
      lookup(m),
    );
    expect(r).toHaveLength(2);
    expect(r[0]).not.toBeNull();
    expect(r[1]).toBeNull();
  });

  it('connects the FACING sides — right→left for a forward edge, arrow pointing right', () => {
    const m: RMap = { A: { x: 0, y: 0, w: 100, h: 50 }, B: { x: 300, y: 200, w: 100, h: 50 } };
    const pts = points(routeEdges([{ from: 'A', to: 'B' }], lookup(m))[0]!.d); // [A,c1,c2,B]
    expect(pts[0]!.x).toBeCloseTo(100, 1); // leaves A's RIGHT side (a.x + a.w)
    const end = pts[3]!;
    expect(end.x).toBeCloseTo(300, 1); // arrives at B's LEFT side (b.x)
    expect(end.y).toBeGreaterThan(200); // …within B's height
    expect(end.y).toBeLessThan(250);
    expect(end.x - pts[2]!.x).toBeGreaterThan(1); // end tangent points RIGHT into the left side
  });

  it('connects the FACING sides for a BACK edge — left→right (no crossing the block)', () => {
    // B sits to the LEFT of A: the edge must leave A's left and enter B's right.
    const m: RMap = { A: { x: 300, y: 0, w: 100, h: 50 }, B: { x: 0, y: 0, w: 100, h: 50 } };
    const pts = points(routeEdges([{ from: 'A', to: 'B' }], lookup(m))[0]!.d);
    expect(pts[0]!.x).toBeCloseTo(300, 1); // leaves A's LEFT side (a.x)
    expect(pts[3]!.x).toBeCloseTo(100, 1); // arrives at B's RIGHT side (b.x + b.w)
  });

  it('connects TOP/BOTTOM for a stacked pair (target directly below)', () => {
    const m: RMap = { A: { x: 0, y: 0, w: 100, h: 50 }, B: { x: 0, y: 300, w: 100, h: 50 } };
    const pts = points(routeEdges([{ from: 'A', to: 'B' }], lookup(m))[0]!.d);
    expect(pts[0]!.y).toBeCloseTo(50, 1); // leaves A's BOTTOM (a.y + a.h)
    expect(pts[3]!.y).toBeCloseTo(300, 1); // arrives at B's TOP (b.y)
  });

  it('fans two edges into one target to DISTINCT entry points (no shared arrowhead)', () => {
    const m: RMap = {
      A: { x: 0, y: 0, w: 100, h: 50 },
      B: { x: 0, y: 200, w: 100, h: 50 },
      T: { x: 300, y: 80, w: 100, h: 80 },
    };
    const [r1, r2] = routeEdges(
      [
        { from: 'A', to: 'T' },
        { from: 'B', to: 'T' },
      ],
      lookup(m),
    );
    expect(points(r1!.d)[3]!.y).not.toBe(points(r2!.d)[3]!.y); // distinct entry heights on T's left
  });

  it('fans two edges off one source to DISTINCT exit points', () => {
    const m: RMap = {
      S: { x: 0, y: 0, w: 100, h: 100 },
      X: { x: 300, y: 0, w: 100, h: 50 },
      Y: { x: 300, y: 300, w: 100, h: 50 },
    };
    const [rx, ry] = routeEdges(
      [
        { from: 'S', to: 'X' },
        { from: 'S', to: 'Y' },
      ],
      lookup(m),
    );
    expect(points(rx!.d)[0]!.y).not.toBe(points(ry!.d)[0]!.y);
  });

  it('ARCS a long horizontal edge so it clears a card between the columns', () => {
    // A and B are far apart on the same row → the curve must bow above the row.
    const m: RMap = { A: { x: 0, y: 0, w: 100, h: 50 }, B: { x: 900, y: 0, w: 100, h: 50 } };
    const pts = points(routeEdges([{ from: 'A', to: 'B' }], lookup(m))[0]!.d);
    expect(Math.min(...pts.map((p) => p.y))).toBeLessThan(0); // a control point rose above the row
  });

  it('does NOT arc a short neighbour edge (stays flat between adjacent cards)', () => {
    const m: RMap = { A: { x: 0, y: 0, w: 100, h: 50 }, B: { x: 200, y: 0, w: 100, h: 50 } };
    const pts = points(routeEdges([{ from: 'A', to: 'B' }], lookup(m))[0]!.d);
    expect(Math.min(...pts.map((p) => p.y))).toBeGreaterThanOrEqual(0); // no bow
  });
});
