// The Motir brand mark — the WAVE BAND, approved by Yue on 2026-08-06
// (MOTIR-1140 · design/brand/design-notes.md §1).
//
// THIS FILE IS THE ONE PLACE THE PATH LIVES. Every surface that renders the
// mark — the React component, both OpenGraph cards, the email header, the
// favicon / app-icon generator — reads it from here, so changing the mark is a
// single-file edit (design-notes.md "Notes for MOTIR-1150"). The path is copied
// verbatim from `design/brand/wave-band-24.svg`, which is itself derived from
// Yue's editable draw.io source; `tests/brand/waveBand.test.ts` asserts the two
// still agree, so a hand-edit here fails the suite.
//
// To change the mark: edit `design/brand/motir-logo.drawio.svg`, re-derive
// `design/brand/wave-band-24.svg`, then update this constant. Never hand-edit
// the path.

/** The 24-unit icon grid the path is drawn on. */
export const WAVE_BAND_VIEW_BOX = '0 0 24 24';

/**
 * One closed path — SIX quadratic curves + two straight caps.
 * Filled, never stroked (design-notes.md §2 "paint").
 *
 * ⚠️ THE CURVE MEETS EACH CAP TANGENT-VERTICALLY (MOTIR-3181). The band ends in a
 * straight vertical cap at each side, and the curve used to arrive at it 14.7°
 * (right) and 19.3° (left) OFF vertical — a visible corner at the box's vertical
 * midpoint, which is the defect Yue reported. Each final quadratic is now split at
 * 0.75 and its tail re-aimed so the curve arrives EXACTLY vertical; both junctions
 * measure 0.00000° and every interior join stays tangent-continuous. That is why
 * there are six quadratics where there used to be four — the two extra segments are
 * the eased tails, not a re-fitting of the shape.
 *
 * ⚠️ AND IT SPANS THE viewBox EDGE TO EDGE (0..24 on both axes), which is also the
 * fix rather than an oversight. The viewport boundary is
 * pixel-aligned at EVERY scale, so a straight cap that coincides with it renders
 * crisp at every size; an INSET cap lands on a whole device pixel only at exact
 * multiples of the grid. The previous path carried a ~1-unit margin (caps at
 * 1.008 / 22.992) and its vertical edges measured alpha 84 / 233 / 211 / 168 /
 * 166 / 80 at 16 / 26 / 28 / 32 / 56 / 64 px — the contour reading "about a pixel
 * out". Edge to edge it measures 255 at all of them.
 *
 * So do NOT re-introduce padding here. Whitespace around the mark belongs to the
 * CONSUMER — that is exactly what the icon generator's glyph-box scales are for.
 */
export const WAVE_BAND_PATH =
  'M0 0Q7 15.5 13 4.1875Q17.5 -4.2969 21.4375 4.3398Q24 9.9606 24 12L24 24Q19 5.125 13 18.5625Q8.5 28.6406 3.4375 19.9102Q0 13.9821 0 12Z';

// ── The baked-colour literals ───────────────────────────────────────────────
//
// `fill="currentColor"` only themes when the SVG is INLINE (design-notes.md §2).
// Through an <img src>, as a favicon, or inside `next/og` — none of which sit in
// the CSS tree — currentColor resolves to black, so those surfaces need a baked
// colour. These are the LIGHT-theme literals of the tokens named beside them,
// taken from `packages/design-system/theme.css`; that provenance is the thing to
// keep in sync (design-notes.md §5 / §6, the documented raster exception to the
// --el-* rule).

/** `--el-accent` / `--color-primary`, light theme. */
export const BRAND_ACCENT_HEX = '#5645d4';
/** `--el-accent-text`, light theme — the ink ON an accent fill. */
export const BRAND_ACCENT_INK_HEX = '#ffffff';
/** `--el-page-bg`, light theme — the manifest's `background_color`. */
export const BRAND_PAGE_BG_HEX = '#ffffff';

/**
 * The glyph as a standalone SVG document with its colour BAKED IN.
 *
 * ⚠️ It emits no comments: XML forbids a double hyphen inside one, and a token
 * name written as `var(...)` in an SVG header is exactly how a file becomes
 * malformed (design-notes.md §2 warning). Provenance lives in this module, in
 * source, where it can say `--el-accent` safely.
 */
export function waveBandSvg({ size, fill }: { size: number; fill: string }): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${WAVE_BAND_VIEW_BOX}" ` +
    `width="${size}" height="${size}" role="img" aria-label="Motir">` +
    `<path d="${WAVE_BAND_PATH}" fill="${fill}"/>` +
    `</svg>`
  );
}

/**
 * The same glyph as a `data:` URI, for the ONE surface that can use neither an
 * inline `<svg>` nor a hosted file: transactional email. Outlook's Word renderer
 * drops inline SVG and Gmail strips `<style>`, so the mark ships as an `<img>`
 * with a literal colour (design-notes.md §7e).
 */
export function waveBandDataUri({ size, fill }: { size: number; fill: string }): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(waveBandSvg({ size, fill }))}`;
}
