import { describe, expect, it } from 'vitest';
import { WAVE_BAND_PATH } from '@/components/brand/waveBand';
import {
  FLOW_EASE_MS,
  FLOW_ENERGY,
  capHeights,
  easedEnergy,
  waveBandFlowFrame,
  waveBandFlowPath,
  waveHueAt,
} from '@/components/brand/waveBandFlow';

// MOTIR-9213 — the colour wave flow's pure half (design `design/ai-chat/design-notes.md`
// § _The Motir mark at work_ › _The motion_). Every frame is a function of `t` and
// `e`, so the shape, the caps and the colour are asserted without a frame loop.

/** The numbers of a path, in order. */
const numbers = (d: string) => (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
/** The command letters of a path, in order. */
const letters = (d: string) => d.replace(/[^A-Za-z]/g, '');

/** A spread of times across several full cycles of every sinusoid in the motion. */
const TIMES = Array.from({ length: 400 }, (_, i) => i * 0.137);

describe('the rest shape is the shipped mark', () => {
  it('zero energy answers WAVE_BAND_PATH verbatim, at any time', () => {
    for (const t of [0, 1.6, 42, -3]) expect(waveBandFlowPath(t, 0)).toBe(WAVE_BAND_PATH);
  });

  it('a whole frame at zero energy is the rest path, its stops pulled fully to the ink', () => {
    const frame = waveBandFlowFrame(7, 0);
    expect(frame.d).toBe(WAVE_BAND_PATH);
    for (const stop of frame.stops) expect(stop).toMatch(/ 0\.0%, var\(--el-accent-text\)\)$/);
  });

  it('the ease ends exactly on rest, and on the flowing energy', () => {
    expect(easedEnergy(FLOW_ENERGY, 0, FLOW_EASE_MS)).toBe(0);
    expect(easedEnergy(FLOW_ENERGY, 0, FLOW_EASE_MS * 3)).toBe(0);
    expect(easedEnergy(0, FLOW_ENERGY, FLOW_EASE_MS)).toBe(FLOW_ENERGY);
    expect(easedEnergy(0, FLOW_ENERGY, 0)).toBe(0);
    const half = easedEnergy(0, FLOW_ENERGY, FLOW_EASE_MS / 2);
    // Ease-OUT: past the halfway energy at half the time.
    expect(half).toBeGreaterThan(FLOW_ENERGY / 2);
    expect(half).toBeLessThan(FLOW_ENERGY);
  });
});

describe('the flowing shape', () => {
  it('keeps the path’s commands and point count, and moves it', () => {
    const rest = numbers(WAVE_BAND_PATH);
    for (const t of [0.4, 2, 5.5]) {
      const d = waveBandFlowPath(t, FLOW_ENERGY);
      expect(letters(d)).toBe(letters(WAVE_BAND_PATH));
      expect(numbers(d)).toHaveLength(rest.length);
      expect(d).not.toBe(WAVE_BAND_PATH);
    }
  });

  it('every value stays finite, for every time and energy', () => {
    for (const t of TIMES) {
      for (const e of [0.01, 0.3, FLOW_ENERGY, 1]) {
        for (const n of numbers(waveBandFlowPath(t, e))) expect(Number.isFinite(n)).toBe(true);
        const { axis } = waveBandFlowFrame(t, e);
        for (const v of Object.values(axis)) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('each cap pinches to 0 and swells to 18 at the flowing energy, and never goes negative', () => {
    const left = TIMES.map((t) => capHeights(t, FLOW_ENERGY).left);
    const right = TIMES.map((t) => capHeights(t, FLOW_ENERGY).right);
    for (const caps of [left, right]) {
      expect(Math.min(...caps)).toBeGreaterThanOrEqual(0);
      expect(Math.min(...caps)).toBeLessThan(0.05);
      expect(Math.max(...caps)).toBeGreaterThan(17.95);
      expect(Math.max(...caps)).toBeLessThanOrEqual(18);
    }
    // Exactly 0 where the sine bottoms out, and 12 — the rest cap — at no energy.
    expect(capHeights((1.5 * Math.PI) / 1.3, FLOW_ENERGY).left).toBeCloseTo(0, 9);
    expect(capHeights((1.5 * Math.PI - 2.2) / 1.05, FLOW_ENERGY).right).toBeCloseTo(0, 9);
    expect(capHeights(3, 0)).toEqual({ left: 12, right: 12 });
    // Above the flowing energy the cap would cross over: it is clamped at 0.
    for (const t of TIMES) expect(capHeights(t, 1).left).toBeGreaterThanOrEqual(0);
    expect(Math.min(...TIMES.map((t) => capHeights(t, 1).left))).toBe(0);
  });

  it('a pinched left cap draws the band to a point: its two cap ends meet', () => {
    const t = (1.5 * Math.PI) / 1.3;
    const d = waveBandFlowPath(t, FLOW_ENERGY);
    const n = numbers(d.replace(/Z$/, ''));
    // The path starts at the TOP-left point and ends at the BOTTOM-left point.
    const [topY, bottomY] = [n[1]!, n[n.length - 1]!];
    expect(Math.abs(topY - bottomY)).toBeLessThan(0.01);
  });
});

describe('the colour', () => {
  it('names only the three mark roles — no raw colour', () => {
    for (const t of TIMES.slice(0, 60)) {
      for (const stop of waveBandFlowFrame(t, FLOW_ENERGY).stops) {
        expect(stop).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
        const vars = [...stop.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
        for (const v of vars) expect(v).toMatch(/^--el-mark-wave-[123]$/);
      }
    }
  });

  it('cycles 1 → 2 → 3 → 1, one hue step ahead between the two stops', () => {
    expect(waveHueAt(0)).toBe(
      'color-mix(in srgb, var(--el-mark-wave-2) 0.0%, var(--el-mark-wave-1))',
    );
    expect(waveHueAt(1)).toBe(
      'color-mix(in srgb, var(--el-mark-wave-3) 0.0%, var(--el-mark-wave-2))',
    );
    expect(waveHueAt(2)).toBe(
      'color-mix(in srgb, var(--el-mark-wave-1) 0.0%, var(--el-mark-wave-3))',
    );
    expect(waveHueAt(3)).toBe(waveHueAt(0));
    expect(waveHueAt(-1)).toBe(waveHueAt(2));
    // Smoothstep: halfway between two roles is an even blend.
    expect(waveHueAt(0.5)).toBe(
      'color-mix(in srgb, var(--el-mark-wave-2) 50.0%, var(--el-mark-wave-1))',
    );
    const [s0, s1] = waveBandFlowFrame(0, FLOW_ENERGY).stops;
    expect(s0).toBe(waveHueAt(0));
    expect(s1).toBe(waveHueAt(1));
  });

  it('a stop is pulled toward the circle’s ink as the energy falls', () => {
    const [s0] = waveBandFlowFrame(0, FLOW_ENERGY / 2).stops;
    expect(s0).toBe(`color-mix(in srgb, ${waveHueAt(0)} 50.0%, var(--el-accent-text))`);
  });

  it('the gradient axis turns about the centre of the 24-unit grid', () => {
    expect(waveBandFlowFrame(0, FLOW_ENERGY).axis).toEqual({ x1: 0, y1: 12, x2: 24, y2: 12 });
    const { axis } = waveBandFlowFrame(Math.PI / 1.2, FLOW_ENERGY); // a = π/2
    expect(axis.x1).toBeCloseTo(12, 2);
    expect(axis.y1).toBeCloseTo(0, 2);
    expect(axis.y2).toBeCloseTo(24, 2);
  });
});
