import { describe, expect, it } from 'vitest';
import {
  annularWedgePath,
  differenceBands,
  donutSegments,
  pointOnCircle,
  polygonPath,
  type DonutGeometry,
  type XYPoint,
} from '@/components/ui/charts/geometry';

// Pure donut + difference-area geometry (Subtask 6.3.4) — the dependency-free
// maths the two new SVG chart forms build on (no d3, no charting library).
// Unit-tested in isolation so the geometry stays correct independent of React.

const GEO: DonutGeometry = { cx: 110, cy: 110, outerR: 92, innerR: 54 };

describe('pointOnCircle (clockwise from the top)', () => {
  it('maps the cardinal angles', () => {
    expect(pointOnCircle(110, 110, 92, 0)).toEqual({ x: 110, y: 18 }); // top
    expect(pointOnCircle(110, 110, 92, 90)).toEqual({ x: 202, y: 110 }); // right
    expect(pointOnCircle(110, 110, 92, 180)).toEqual({ x: 110, y: 202 }); // bottom
    expect(pointOnCircle(110, 110, 92, 270)).toEqual({ x: 18, y: 110 }); // left
  });
});

describe('annularWedgePath', () => {
  it('matches the 6.3.3 mock arc for a 0→135° wedge (To Do, 37.5%)', () => {
    expect(annularWedgePath(GEO, 0, 135)).toBe(
      'M110,18 A92 92 0 0 1 175.05,175.05 L148.18,148.18 A54 54 0 0 0 110,56 Z',
    );
  });

  it('sets the large-arc flag once a wedge spans more than 180°', () => {
    expect(annularWedgePath(GEO, 0, 90)).toContain('A92 92 0 0 1'); // small
    expect(annularWedgePath(GEO, 0, 270)).toContain('A92 92 0 1 1'); // large
  });

  it('falls back to a two-circle ring for a full 360° group (no degenerate arc)', () => {
    const d = annularWedgePath(GEO, 0, 360);
    // two sub-paths (outer + inner), no NaN
    expect(d.match(/M/g)?.length).toBe(2);
    expect(d).not.toContain('NaN');
  });
});

describe('donutSegments', () => {
  it('computes shares, cumulative angles, and ramp colour indices', () => {
    const segs = donutSegments(
      [
        { label: 'To Do', value: 30 },
        { label: 'In Progress', value: 16 },
        { label: 'Done', value: 22 },
        { label: 'In Review', value: 8 },
        { label: 'Blocked', value: 4 },
      ],
      GEO,
    );
    expect(segs.map((s) => Math.round(s.percentage * 10) / 10)).toEqual([37.5, 20, 27.5, 10, 5]);
    expect(segs.map((s) => s.colorIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(segs.every((s) => !s.neutral)).toBe(true);
    // angles run clockwise from 0 and close the circle at 360
    expect(segs[0]!.startAngle).toBe(0);
    expect(segs.at(-1)!.endAngle).toBeCloseTo(360, 6);
  });

  it('returns [] for empty / all-zero / negative data (the empty-state guard)', () => {
    expect(donutSegments([], GEO)).toEqual([]);
    expect(donutSegments([{ label: 'a', value: 0 }], GEO)).toEqual([]);
    expect(donutSegments([{ label: 'a', value: -5 }], GEO)).toEqual([]);
  });

  it('pins the None group to a neutral wedge, always last', () => {
    const segs = donutSegments(
      [
        { label: 'Alice', value: 10 },
        { label: 'Unassigned', value: 6, none: true },
        { label: 'Bob', value: 4 },
      ],
      GEO,
    );
    const none = segs.at(-1)!;
    expect(none.label).toBe('Unassigned');
    expect(none.neutral).toBe(true);
    expect(none.colorIndex).toBe(-1);
    // the non-None groups keep ramp slots 0,1
    expect(segs.slice(0, 2).map((s) => s.colorIndex)).toEqual([0, 1]);
  });

  it('aggregates multiple None groups into one wedge labelled "None"', () => {
    const segs = donutSegments(
      [
        { label: 'Alice', value: 10 },
        { label: 'Unassigned', value: 3, none: true },
        { label: 'No component', value: 2, none: true },
      ],
      GEO,
    );
    const none = segs.at(-1)!;
    expect(none.label).toBe('None');
    expect(none.value).toBe(5);
    expect(none.neutral).toBe(true);
  });

  it('rolls segments beyond the ramp length into one "+N more" neutral wedge', () => {
    const data = Array.from({ length: 9 }, (_, i) => ({ label: `S${i}`, value: 10 }));
    const segs = donutSegments(data, GEO, { rampLength: 7 });
    // 6 distinct hues + 1 rollup = 7 wedges
    expect(segs).toHaveLength(7);
    expect(segs.slice(0, 6).map((s) => s.colorIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    const rollup = segs.at(-1)!;
    expect(rollup.label).toBe('+3 more');
    expect(rollup.neutral).toBe(true);
    expect(rollup.value).toBe(30); // the 3 rolled-up tail segments
  });

  it('renders a single 100% group as a full ring', () => {
    const segs = donutSegments([{ label: 'Done', value: 5 }], GEO);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.percentage).toBe(100);
    expect(segs[0]!.path.match(/M/g)?.length).toBe(2); // the two-circle ring
  });
});

describe('differenceBands', () => {
  it('emits one trapezoid per interval when one series stays above the other', () => {
    const created: XYPoint[] = [
      { x: 0, y: 10 },
      { x: 1, y: 12 },
    ];
    const resolved: XYPoint[] = [
      { x: 0, y: 4 },
      { x: 1, y: 5 },
    ];
    const bands = differenceBands(created, resolved);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.kind).toBe('deficit'); // created (value) above resolved
    expect(bands[0]!.polygon).toHaveLength(4);
  });

  it('splits an interval at the crossover into a deficit + a surplus triangle', () => {
    const created: XYPoint[] = [
      { x: 0, y: 10 },
      { x: 1, y: 0 },
    ];
    const resolved: XYPoint[] = [
      { x: 0, y: 0 },
      { x: 1, y: 10 },
    ];
    const bands = differenceBands(created, resolved);
    expect(bands).toHaveLength(2);
    expect(bands[0]!.kind).toBe('deficit'); // created starts above
    expect(bands[1]!.kind).toBe('surplus'); // resolved ends above
    expect(bands[0]!.polygon).toHaveLength(3);
    // crossover is the shared second vertex of the first triangle
    const cross = bands[0]!.polygon[1]!;
    expect(cross.x).toBeCloseTo(0.5, 6);
    expect(cross.y).toBeCloseTo(5, 6);
  });

  it('splits the other way too — surplus then deficit when resolved starts above', () => {
    const created: XYPoint[] = [
      { x: 0, y: 0 },
      { x: 1, y: 10 },
    ];
    const resolved: XYPoint[] = [
      { x: 0, y: 10 },
      { x: 1, y: 0 },
    ];
    const bands = differenceBands(created, resolved);
    expect(bands.map((b) => b.kind)).toEqual(['surplus', 'deficit']);
  });

  it('skips a coincident interval (no shaded area)', () => {
    const flat: XYPoint[] = [
      { x: 0, y: 3 },
      { x: 1, y: 3 },
    ];
    expect(differenceBands(flat, flat)).toEqual([]);
  });
});

describe('polygonPath', () => {
  it('builds a closed M/L path', () => {
    expect(
      polygonPath([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toBe('M0,0 L10,0 L10,10 Z');
  });

  it('returns an empty string for no points', () => {
    expect(polygonPath([])).toBe('');
  });
});
