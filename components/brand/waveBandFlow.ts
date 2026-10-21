import { WAVE_BAND_PATH } from './waveBand';

// THE MOTIR MARK AT WORK — the colour wave flow (MOTIR-9213; design
// `design/ai-chat/design-notes.md` § _The Motir mark at work_ › _The motion_,
// MOTIR-9212). The pure half: every frame of the motion is a function of `t`
// (seconds since the mark started flowing) and `e` (the energy), so the shape
// and the colour can be asserted without a frame loop. `BrandMarkFlow` runs it.
//
// ⚠️ THE REST SHAPE IS NOT RESTATED HERE. The points are parsed from
// `WAVE_BAND_PATH`, the one place the mark lives, and `e = 0` answers that
// constant verbatim — so every animation ends on exactly the shipped glyph.

/** The energy while the mark flows — the prototype's default. */
export const FLOW_ENERGY = 0.75;

/**
 * How long the energy takes to ease in or out: `2 × --transition-slow`, the
 * design's figure at the default style (250 ms). A constant rather than a CSS
 * read, because the frame loop runs off the CSS tree.
 */
export const FLOW_EASE_MS = 500;

type Command = { c: string; n: number[] };

/** The path's commands, parsed once. Points before `L` are the TOP edge. */
const COMMANDS: readonly Command[] = (WAVE_BAND_PATH.match(/[MQLZ][^MQLZ]*/g) ?? []).map((s) => ({
  c: s[0]!,
  n: (s.slice(1).match(/-?\d*\.?\d+/g) ?? []).map(Number),
}));

const TAU = Math.PI * 2;
const round = (v: number) => +v.toFixed(3);

/**
 * The band's two cap heights at `(t, e)`: 12 at rest, pinching to 0 and swelling
 * to 18 at the flowing energy.
 *
 * ⚠️ `12 − 4e + 12e·sin(…)`, not the design table's `16e`: the table's own range
 * (0 to 18) and its note that the form equals the prototype's `9 + 12e·sin(…)` at
 * `e = 0.75` both hold only for `12e` — `16e` swells to 21. This keeps both, and
 * keeps the rest shape at `e = 0` that the rewrite was for.
 */
export function capHeights(t: number, e: number): { left: number; right: number } {
  return {
    left: Math.max(0, 12 - 4 * e + 12 * e * Math.sin(1.3 * t)),
    right: Math.max(0, 12 - 4 * e + 12 * e * Math.sin(1.05 * t + 2.2)),
  };
}

function movePoint(x: number, y: number, bottom: boolean, t: number, e: number): [number, number] {
  const u = x / 24;
  const { left: hL, right: hR } = capHeights(t, e);
  // Width breathing: each side drawn in by up to 1.95 units.
  const inL = 2.6 * e * (0.5 + 0.5 * Math.sin(1.3 * t));
  const inR = 2.6 * e * (0.5 + 0.5 * Math.sin(0.9 * t + 2));
  // The travelling wave, both edges together, strongest mid-band.
  const wave = 3.4 * e * Math.sin(2.4 * t - TAU * u) * (0.35 + 0.65 * Math.sin(Math.PI * u));
  // The caps blended across the middle; top edge up, bottom edge down.
  const th = 12 + (hL - 12) * (1 - u) ** 2 + (hR - 12) * u ** 2;
  const cap = ((bottom ? 1 : -1) * (th - 12)) / 2;
  return [round(x + inL * (1 - u) - inR * u), round(y + wave + cap)];
}

/** The mark's `d` at `(t, e)`. `e <= 0` is exactly `WAVE_BAND_PATH`. */
export function waveBandFlowPath(t: number, e: number): string {
  if (e <= 0) return WAVE_BAND_PATH;
  let bottom = false;
  return COMMANDS.map(({ c, n }) => {
    if (c === 'L') bottom = true;
    const out: number[] = [];
    for (let i = 0; i < n.length; i += 2) out.push(...movePoint(n[i]!, n[i + 1]!, bottom, t, e));
    return c + out.join(' ');
  }).join('');
}

const role = (i: number) => `var(--el-mark-wave-${(((i % 3) + 3) % 3) + 1})`;

/**
 * The colour at hue position `c`: the three roles in a loop 1 → 2 → 3 → 1, a
 * smoothstep blend between neighbours. Only `--el-mark-wave-*` is ever named.
 */
export function waveHueAt(c: number): string {
  const w = ((c % 3) + 3) % 3;
  const i = Math.floor(w);
  const f = w - i;
  const k = f * f * (3 - 2 * f);
  return `color-mix(in srgb, ${role(i + 1)} ${(k * 100).toFixed(1)}%, ${role(i)})`;
}

/** A stop pulled toward the circle's ink as the energy falls (`1 − e / 0.75`). */
function towardInk(colour: string, e: number): string {
  const share = Math.min(1, Math.max(0, e / FLOW_ENERGY));
  if (share >= 1) return colour;
  return `color-mix(in srgb, ${colour} ${(share * 100).toFixed(1)}%, var(--el-accent-text))`;
}

export interface WaveBandFlowFrame {
  d: string;
  /** The gradient axis, `userSpaceOnUse` on the 24-unit grid. */
  axis: { x1: number; y1: number; x2: number; y2: number };
  /** The two gradient stops, offset 0 and 1. */
  stops: [string, string];
}

/** One whole frame: the shape, the gradient axis and its two stops. */
export function waveBandFlowFrame(t: number, e: number): WaveBandFlowFrame {
  const a = 0.6 * t;
  const c = 0.45 * t;
  return {
    d: waveBandFlowPath(t, e),
    axis: {
      x1: round(12 - 12 * Math.cos(a)),
      y1: round(12 - 12 * Math.sin(a)),
      x2: round(12 + 12 * Math.cos(a)),
      y2: round(12 + 12 * Math.sin(a)),
    },
    stops: [towardInk(waveHueAt(c), e), towardInk(waveHueAt(c + 1), e)],
  };
}

/**
 * The energy `elapsed` ms into an ease from `from` to `to` (ease-out over
 * {@link FLOW_EASE_MS}).
 */
export function easedEnergy(from: number, to: number, elapsed: number): number {
  const p = Math.min(1, Math.max(0, elapsed / FLOW_EASE_MS));
  return from + (to - from) * (1 - (1 - p) ** 3);
}
