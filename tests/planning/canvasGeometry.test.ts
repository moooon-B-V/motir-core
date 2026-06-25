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

  it('leaves the source RIGHT and enters the target LEFT, pointing RIGHT (flow)', () => {
    // A (col 0) → B (col 1): a neighbour edge.
    const m: RMap = { A: { x: 0, y: 0, w: 100, h: 50 }, B: { x: 300, y: 200, w: 100, h: 50 } };
    const pts = points(routeEdges([{ from: 'A', to: 'B' }], lookup(m))[0]!.d);
    expect(pts[0]!.x).toBeCloseTo(100, 1); // leaves a.x + a.w (right edge)
    expect(pts[0]!.y).toBeCloseTo(25, 1); // single out-edge → centre height
    const end = pts[pts.length - 1]!;
    const prev = pts[pts.length - 2]!;
    expect(end.x).toBeCloseTo(300, 1); // lands on the target's LEFT edge (b.x)
    expect(Math.abs(end.y - prev.y)).toBeLessThan(0.5); // final segment horizontal → arrow points right
    expect(end.y).toBeGreaterThan(200); // …within the target's height
    expect(end.y).toBeLessThan(250);
  });

  it('routes a neighbour edge as an in-row S-elbow (no detour above the cards)', () => {
    const m: RMap = { A: { x: 0, y: 0, w: 100, h: 50 }, B: { x: 300, y: 0, w: 100, h: 50 } };
    const pts = points(routeEdges([{ from: 'A', to: 'B' }], lookup(m))[0]!.d);
    const minY = Math.min(...pts.map((p) => p.y));
    expect(minY).toBeGreaterThanOrEqual(0); // never rises above the node row
  });

  it('fans two edges into one target to DISTINCT entry heights AND vertical lanes', () => {
    // A and B both drop a long way into T, so their gutter verticals OVERLAP in y
    // and must be given separate lanes.
    const m: RMap = {
      A: { x: 0, y: 0, w: 100, h: 50 },
      B: { x: 0, y: 80, w: 100, h: 50 },
      T: { x: 300, y: 260, w: 100, h: 80 },
    };
    const [r1, r2] = routeEdges(
      [
        { from: 'A', to: 'T' },
        { from: 'B', to: 'T' },
      ],
      lookup(m),
    );
    const e1 = points(r1!.d);
    const e2 = points(r2!.d);
    expect(e1[e1.length - 1]!.y).not.toBe(e2[e2.length - 1]!.y); // distinct entry heights
    expect(r1!.mid.x).not.toBe(r2!.mid.x); // distinct gutter lanes → no vertical overlap
  });

  it('gives two edges off one source DISTINCT exit heights', () => {
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

  it('detours a SKIP edge over a band above the cards', () => {
    // three columns; A→C skips column B.
    const m: RMap = {
      A: { x: 0, y: 0, w: 100, h: 50 },
      B: { x: 300, y: 0, w: 100, h: 50 },
      C: { x: 600, y: 0, w: 100, h: 50 },
    };
    const r = routeEdges(
      [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
        { from: 'A', to: 'C' },
      ],
      lookup(m),
    );
    const skip = points(r[2]!.d); // A→C
    expect(Math.min(...skip.map((p) => p.y))).toBeLessThan(0); // rose above the row
  });

  it('keeps two OVERLAPPING band runs on separate rows (no line on top of another)', () => {
    const m: RMap = {
      A: { x: 0, y: 0, w: 100, h: 50 },
      M: { x: 300, y: 0, w: 100, h: 50 },
      T: { x: 600, y: 0, w: 100, h: 50 },
      U: { x: 900, y: 0, w: 100, h: 50 },
    };
    // A→T and A→U both skip columns and run rightward across the same band x-range —
    // the router must put them on different band rows.
    const r = routeEdges(
      [
        { from: 'A', to: 'M' },
        { from: 'M', to: 'T' },
        { from: 'T', to: 'U' },
        { from: 'A', to: 'T' },
        { from: 'A', to: 'U' },
      ],
      lookup(m),
    );
    expect(r[3]!.mid.y).not.toBe(r[4]!.mid.y);
  });
});
