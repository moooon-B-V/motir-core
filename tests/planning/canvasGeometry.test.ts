import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  centerOn,
  clampScale,
  edgeMidpoint,
  edgePath,
  fitView,
  nodesBounds,
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

describe('edgeMidpoint', () => {
  it('rides the overhead channel the route runs across (above the target top)', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    const b = { x: 200, y: 400, w: 100, h: 100 };
    const m = edgeMidpoint(a, b);
    // the channel sits TOP_APPROACH (40) above the target's top edge…
    expect(m.y).toBeCloseTo(b.y - 40, 1);
    // …and the midpoint lies horizontally between the source stub and the target.
    expect(m.x).toBeGreaterThan(a.x + a.w);
    expect(m.x).toBeLessThan(b.x + b.w);
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

describe('edgePath', () => {
  it('leaves the source on its RIGHT-centre', () => {
    const pts = points(edgePath({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 10, w: 100, h: 50 }));
    expect(pts[0]!.x).toBeCloseTo(100, 1); // a.x + a.w
    expect(pts[0]!.y).toBeCloseTo(25, 1); // a.y + a.h/2
  });
  it('enters the target on its TOP edge, pointing DOWN (orthogonal turn)', () => {
    const a = { x: 0, y: 0, w: 100, h: 50 };
    const b = { x: 300, y: 200, w: 100, h: 50 };
    const pts = points(edgePath(a, b));
    const end = pts[pts.length - 1]!;
    const prev = pts[pts.length - 2]!;
    expect(end.y).toBeCloseTo(b.y, 1); // lands on the target's TOP edge
    expect(Math.abs(end.x - prev.x)).toBeLessThan(0.5); // final segment vertical → arrow down
    expect(end.x).toBeGreaterThan(b.x); // …within the target's span
    expect(end.x).toBeLessThan(b.x + b.w);
  });
  it('turns at right angles via a channel above the target top', () => {
    const a = { x: 0, y: 0, w: 100, h: 50 };
    const b = { x: 300, y: 200, w: 100, h: 50 };
    // the overhead channel sits TOP_APPROACH (40) above the target's top edge.
    expect(edgePath(a, b)).toContain(',160'); // chY = b.y(200) - 40
  });
  it('fans two edges into one target to DISTINCT top-entry points', () => {
    const target = { x: 400, y: 200, w: 100, h: 50 };
    const e1 = points(edgePath({ x: 0, y: 0, w: 100, h: 50 }, target));
    const e2 = points(edgePath({ x: 200, y: 0, w: 100, h: 50 }, target));
    expect(Math.abs(e1[e1.length - 1]!.x - e2[e2.length - 1]!.x)).toBeGreaterThan(1);
  });
});
