import { describe, expect, it } from 'vitest';
import { clamp, tiltFromPointer } from '@/lib/theme/tilt';

// Subtask 7.3.39 — the pointer-parallax tilt math behind the 3D / Immersive
// style. Pure + DOM-free, so the rotation mapping is pinned directly here; the
// DOM wiring (ImmersiveTilt) reads `--tilt-rx`/`--tilt-ry` from this.

const RECT = { left: 100, top: 200, width: 200, height: 100 };
const MAX = 7;

describe('clamp', () => {
  it('bounds to the inclusive range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe('tiltFromPointer', () => {
  it('is flat at the centre', () => {
    const t = tiltFromPointer(RECT, 200, 250, MAX); // centre of RECT
    expect(t.rx).toBeCloseTo(0);
    expect(t.ry).toBeCloseTo(0);
    expect(t.px).toBeCloseTo(0.5);
    expect(t.py).toBeCloseTo(0.5);
  });

  it('rotates Y toward the cursor on the horizontal axis (right edge → +max)', () => {
    const right = tiltFromPointer(RECT, 300, 250, MAX); // px = 1
    expect(right.ry).toBeCloseTo(MAX);
    const left = tiltFromPointer(RECT, 100, 250, MAX); // px = 0
    expect(left.ry).toBeCloseTo(-MAX);
  });

  it('rotates X on the vertical axis with the top tipping toward the viewer (+max)', () => {
    const top = tiltFromPointer(RECT, 200, 200, MAX); // py = 0
    expect(top.rx).toBeCloseTo(MAX);
    const bottom = tiltFromPointer(RECT, 200, 300, MAX); // py = 1
    expect(bottom.rx).toBeCloseTo(-MAX);
  });

  it('clamps a pointer outside the rect to the edge rotation, never beyond', () => {
    const t = tiltFromPointer(RECT, 9999, 9999, MAX);
    expect(t.ry).toBeCloseTo(MAX);
    expect(t.rx).toBeCloseTo(-MAX);
    expect(Math.abs(t.ry)).toBeLessThanOrEqual(MAX);
    expect(Math.abs(t.rx)).toBeLessThanOrEqual(MAX);
  });

  it('returns a flat tilt for a zero-area rect (no divide-by-zero)', () => {
    const t = tiltFromPointer({ left: 0, top: 0, width: 0, height: 0 }, 10, 10, MAX);
    expect(t).toEqual({ rx: 0, ry: 0, px: 0.5, py: 0.5 });
  });
});
