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
 * One closed path — four quadratic curves + two straight caps, six segments.
 * Filled, never stroked (design-notes.md §2 "paint").
 */
export const WAVE_BAND_PATH =
  'M1.008 1.016Q7.42 15.214 12.916 4.851Q18.412 -5.511 22.992 12.008L22.992 23Q18.412 5.71 12.916 18.019Q7.42 30.328 1.008 12.008Z';

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
