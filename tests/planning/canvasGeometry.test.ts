import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  edgePath,
  fitView,
  nodesBounds,
  screenDeltaToWorld,
  screenToWorld,
  zoomToward,
} from '@/lib/planning/canvasGeometry';

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

describe('edgePath', () => {
  it('anchors right→left for side-by-side nodes', () => {
    const p = edgePath({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 10, w: 100, h: 50 });
    expect(p.startsWith('M100,25')).toBe(true); // A right-centre
    expect(p.endsWith('300,35')).toBe(true); // B left-centre
  });
  it('anchors bottom→top for stacked nodes', () => {
    const p = edgePath({ x: 0, y: 0, w: 100, h: 50 }, { x: 10, y: 200, w: 100, h: 50 });
    expect(p.startsWith('M50,50')).toBe(true); // A bottom-centre
    expect(p.endsWith('60,200')).toBe(true); // B top-centre
  });
  it('anchors left→right when B is to the left', () => {
    const p = edgePath({ x: 300, y: 0, w: 100, h: 50 }, { x: 0, y: 0, w: 100, h: 50 });
    expect(p.startsWith('M300,25')).toBe(true); // A left side
    expect(p.endsWith('100,25')).toBe(true); // B right side
  });
});
