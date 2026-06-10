import { describe, expect, it } from 'vitest';
import {
  areaPath,
  linePath,
  linearScale,
  niceMax,
  niceTicks,
  stepPath,
  type PixelPoint,
} from '@/components/ui/charts/scale';

// Pure charting maths (Subtask 4.6.2) — the dependency-free layer the SVG
// chart primitives build on (no d3, no charting library). These are unit-
// tested in isolation so the geometry stays correct independent of React.

describe('linearScale', () => {
  it('maps the domain endpoints onto the range endpoints', () => {
    const s = linearScale([0, 10], [0, 100]);
    expect(s(0)).toBe(0);
    expect(s(10)).toBe(100);
    expect(s(5)).toBe(50);
  });

  it('inverts for a Y axis (larger value → smaller pixel)', () => {
    // domain 0..40 points, range bottom=200 .. top=0
    const y = linearScale([0, 40], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(40)).toBe(0);
    expect(y(20)).toBe(100);
  });

  it('does not divide by zero on a degenerate domain', () => {
    const s = linearScale([5, 5], [0, 100]);
    expect(Number.isFinite(s(5))).toBe(true);
    expect(s(5)).toBe(0);
  });
});

describe('linePath', () => {
  it('starts with M then L-joins each point', () => {
    const pts: PixelPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 20 },
      { x: 20, y: 5 },
    ];
    expect(linePath(pts)).toBe('M0,0 L10,20 L20,5');
  });

  it('breaks the line into sub-paths across a NaN gap', () => {
    const pts: PixelPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: NaN },
      { x: 20, y: 5 },
    ];
    const d = linePath(pts);
    // two move commands → a gap, not a line dropping through the missing point
    expect(d.match(/M/g)?.length).toBe(2);
  });
});

describe('stepPath', () => {
  it('holds the value then drops at the next x (step-after)', () => {
    // remaining 42 from day 0..2, then drops to 35 at day 2
    const pts: PixelPoint[] = [
      { x: 0, y: 0 },
      { x: 54, y: 0 },
      { x: 108, y: 36 },
    ];
    const d = stepPath(pts);
    // a horizontal segment to the next x at the OLD y, then a vertical to the new y
    expect(d).toContain('L108,0');
    expect(d).toContain('L108,36');
    expect(d.startsWith('M0,0')).toBe(true);
  });
});

describe('areaPath', () => {
  it('closes the line down to the baseline', () => {
    const pts: PixelPoint[] = [
      { x: 0, y: 10 },
      { x: 20, y: 30 },
    ];
    const line = linePath(pts);
    const area = areaPath(line, pts, 200);
    expect(area).toContain('L20,200');
    expect(area).toContain('L0,200');
    expect(area.endsWith('Z')).toBe(true);
  });
});

describe('niceTicks / niceMax', () => {
  it('produces 0-anchored rounded ticks covering the max', () => {
    expect(niceTicks(42, 4)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(niceMax(42, 4)).toBe(50);
  });

  it('degrades safely for non-positive maxima', () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(-5)).toEqual([0]);
    expect(niceTicks(Number.NaN)).toEqual([0]);
  });
});
