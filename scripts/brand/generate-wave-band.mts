/**
 * The Motir wave band's ARTWORK GENERATOR (MOTIR-3181).
 *
 * Emits `design/brand/wave-band.svg` and `design/brand/wave-band-24.svg`.
 * `tests/brand/waveBandGenerator.test.ts` asserts the committed files equal its
 * current output, the same guard shape `tests/brand/iconAssets.test.ts` puts on
 * the rasters — so the artwork cannot drift from the parameters that describe it.
 *
 * ── WHY THE ARTWORK IS GENERATED ────────────────────────────────────────────
 * It used to be hand-derived from `motir-logo.drawio.svg`, with a warning in both
 * files not to edit the path. Two of the three corrections below cannot be drawn
 * by hand at all — draw.io has no notion of "make this tangent vertical" — so the
 * derivation moves here and the .drawio file stays as Yue's editable CONCEPT
 * sketch, no longer the derivation source.
 *
 * ── THE THREE CORRECTIONS, AND THE SHAPE IS NOT ONE OF THEM ─────────────────
 * The mark is the wave band approved on 2026-08-06 (MOTIR-1140). Its two crests,
 * its rhythm and its proportions are unchanged. What was wrong was how the file
 * expressed it:
 *
 * 1 · THE CORNER AT EACH CAP — the defect Yue reported.
 *   "the points where the vertical line meet the curve — the middle point of the
 *   box, the angle looks sharp, I want the curve turn to the vertical line
 *   smoothly."
 *   The band ends in a straight VERTICAL cap at each side, and the curve used to
 *   arrive at it travelling 14.7° (right) and 19.3° (left) off vertical — a
 *   visible kink at exactly the box's vertical midpoint. {@link EASE_START} now
 *   splits the final quadratic and re-aims only its TAIL so the curve arrives
 *   travelling EXACTLY vertically: the junction is tangent-continuous and reads
 *   as a curve flowing into a straight line.
 *
 *   Why a split rather than re-aiming the whole segment: a quadratic's end
 *   tangent is `E − C`, so "vertical" means `C.x === E.x`, and forcing that on
 *   the full-length segment drags the control far outside the box — it turns the
 *   mark into a 0.66-aspect ribbon. Splitting at 0.75 confines the change to the
 *   last quarter, where the overlay against the old outline shows it, and leaves
 *   the aspect at 0.999.
 *
 * 2 · THE CAPS SIT ON THE viewBox EDGE, and that is deliberate.
 *   The 24-grid cut used to inset ~1 unit (caps at x = 1.008 / 22.992) where the
 *   native artwork had none. An INSET vertical edge lands on a whole device pixel
 *   only at exact multiples of the grid; the viewport BOUNDARY is pixel-aligned at
 *   every scale. So the caps antialiased into a soft 1–2 px seam at 16/26/28/32/56/64
 *   px — measured alpha 84/233/211/168/166/80 out of 255 — and are 255 everywhere
 *   edge to edge. Do NOT "tidy" a margin back in: padding belongs to the CONSUMER
 *   (the icon generator's glyph-box scale), never to the artwork.
 *
 * 3 · NO STRAY OFFSET. Every `y` carried a `+0.54` and the viewBox was 768.54 tall,
 *   so nothing sat on a whole unit. The frame is now exact.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Pt = readonly [number, number];

/**
 * The approved mark, in its own 768 frame: the crest curve as two quadratics,
 * then the same curve offset for the lower edge. These control points are the
 * 2026-08-06 artwork's, with only the stray `+0.54` removed — the shape is not
 * re-chosen here and this generator must never be used to re-choose it.
 */
export const UPPER: ReadonlyArray<readonly [Pt, Pt, Pt]> = [
  [
    [0, 0],
    [224, 496],
    [416, 134],
  ],
  [
    [416, 134],
    [608, -228],
    [768, 384],
  ],
];
export const LOWER: ReadonlyArray<readonly [Pt, Pt, Pt]> = [
  [
    [768, 768],
    [608, 164],
    [416, 594],
  ],
  [
    [416, 594],
    [224, 1024],
    [0, 384],
  ],
];

/**
 * Where the final quadratic is split so its tail can turn vertical.
 *
 * 0.75 is chosen, not arbitrary: below ~0.7 the ease starts early enough to
 * visibly fatten the ends, and above ~0.8 the turn is too short to remove the
 * corner by eye (0.85 still reads as a kink). At 0.75 the overlay against the old
 * outline diverges only in the last stretch before each cap.
 */
export const EASE_START = 0.75;

const at = (q: readonly [Pt, Pt, Pt], t: number): Pt => {
  const u = 1 - t;
  return [
    u * u * q[0][0] + 2 * u * t * q[1][0] + t * t * q[2][0],
    u * u * q[0][1] + 2 * u * t * q[1][1] + t * t * q[2][1],
  ];
};
const der = (q: readonly [Pt, Pt, Pt], t: number): Pt => [
  2 * (1 - t) * (q[1][0] - q[0][0]) + 2 * t * (q[2][0] - q[1][0]),
  2 * (1 - t) * (q[1][1] - q[0][1]) + 2 * t * (q[2][1] - q[1][1]),
];

/**
 * Split `q` at {@link EASE_START} and re-aim the tail so it ends travelling
 * VERTICALLY at `capX`.
 *
 * The head keeps the original curve exactly (its control is the de Casteljau
 * restriction). The tail starts at the split point with the SAME tangent — so the
 * new interior join is tangent-continuous — and its control is placed on the
 * vertical line through the endpoint, which is what makes the end tangent
 * vertical. Both conditions together determine the control uniquely; there is
 * nothing to tune but where the split goes.
 */
export function easeToVertical(
  q: readonly [Pt, Pt, Pt],
  capX: number,
  t0: number = EASE_START,
): { head: [Pt, Pt, Pt]; tail: [Pt, Pt, Pt] } {
  const S = at(q, t0);
  const T = der(q, t0);
  const headC: Pt = [q[0][0] + (q[1][0] - q[0][0]) * t0, q[0][1] + (q[1][1] - q[0][1]) * t0];
  const s = (capX - S[0]) / T[0];
  const tailC: Pt = [capX, S[1] + s * T[1]];
  return { head: [q[0], headC, S], tail: [S, tailC, q[2]] };
}

/** The six curve segments of the closed band, in draw order. */
export function segments(): Array<[Pt, Pt, Pt]> {
  const u = easeToVertical(UPPER[1]!, 768);
  const l = easeToVertical(LOWER[1]!, 0);
  return [
    [UPPER[0]![0], UPPER[0]![1], UPPER[0]![2]],
    u.head,
    u.tail,
    [LOWER[0]![0], LOWER[0]![1], LOWER[0]![2]],
    l.head,
    l.tail,
  ];
}

/**
 * Fit so the band's X extent is EXACTLY the box — which is what puts the two
 * straight caps on the viewBox edge, and therefore on a device-pixel boundary at
 * every scale. Y is centred; the aspect is preserved (it measures 0.999, so the
 * vertical slack is under a unit).
 */
export function render(box: number, dp: number): string {
  const segs = segments();
  // The 768 frame IS the box: x runs 0..768 (the two caps) and the cap midpoint
  // sits at y = 384. Scaling by `box / 768` with NO offset therefore maps the caps
  // onto x = 0 / x = box and the junction onto y = box / 2 — every salient point on
  // a whole unit, and every coordinate an exact division. Centring the bbox instead
  // would buy nothing and cost a fractional offset on every y.
  const sc = box / 768;
  const dy = 0;
  const r = (n: number): string => {
    const v = Number(n.toFixed(dp));
    return String(Object.is(v, -0) ? 0 : v);
  };
  const m = (p: Pt): string => `${r(p[0] * sc)} ${r(p[1] * sc + dy)}`;

  const d = [`M${m(segs[0]![0])}`];
  for (const s of segs.slice(0, 3)) d.push(`Q${m(s[1])} ${m(s[2])}`);
  d.push(`L${m([768, 768])}`);
  for (const s of segs.slice(3)) d.push(`Q${m(s[1])} ${m(s[2])}`);
  d.push('Z');
  return d.join('');
}

const HEADER = (grid: string): string => `<!--
  Motir brand mark — the wave band. ${grid}

  GENERATED — do not hand-edit. Run \`pnpm tsx scripts/brand/generate-wave-band.mts\`;
  \`tests/brand/waveBandGenerator.test.ts\` asserts this file equals the generator's
  current output, so a hand-edit fails the suite. The CONCEPT lives in
  design/brand/motir-logo.drawio.svg (Yue's editable sketch); it is no longer the
  derivation source, because the tangent conditions below cannot be drawn by hand.

  REFINED, NOT RE-DRAWN (MOTIR-3181). Same approved mark, same two crests, same
  rhythm. Three things the file used to get wrong:
    1. The curve met each straight vertical cap 14.7° / 19.3° OFF vertical — a
       visible corner at the box's vertical midpoint. The final quadratic is now
       split at 0.75 and its tail re-aimed so the curve arrives EXACTLY vertical:
       the junction is tangent-continuous.
    2. The 24-grid cut inset ~1 unit where the native artwork had none, so the caps
       antialiased into a soft seam at every size that is not a multiple of the
       grid. They now sit ON the viewBox edge, which is pixel-aligned at every
       scale. Padding belongs to the consumer, never to the artwork.
    3. A stray +0.54 on every y. The frame is exact.

  fill="currentColor" is deliberate: the mark carries NO colour of its own, so it
  follows the theme and the palette from whatever renders it. Set the colour on the
  consuming element (the accent-on-surface element token) and never inside this file.
  WARNING: that only works INLINE (<svg> / <use> / an imported component). Via
  <img src> or as a favicon, currentColor resolves to black and a baked-colour
  variant is required instead.

  See design/brand/design-notes.md sections 1 and 2.
-->
`;

export const ASSETS = [
  { file: 'design/brand/wave-band.svg', box: 768, dp: 2, grid: 'Production artwork, native size.' },
  { file: 'design/brand/wave-band-24.svg', box: 24, dp: 4, grid: '24-grid cut, aspect preserved.' },
] as const;

export function assetContents(spec: (typeof ASSETS)[number]): string {
  return (
    HEADER(spec.grid) +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${spec.box} ${spec.box}" width="${spec.box}" height="${spec.box}" role="img" aria-label="Motir">\n` +
    `  <path d="${render(spec.box, spec.dp)}" fill="currentColor" />\n</svg>\n`
  );
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  for (const spec of ASSETS) {
    await writeFile(path.join(REPO, spec.file), assetContents(spec), 'utf8');
    console.warn(`wrote ${spec.file}`);
  }
}
