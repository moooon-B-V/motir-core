// The OG card's typeface — the MANIFEST half. The BYTES live beside it, in this
// package's `fonts/` directory, and ship in the published tarball (`files`).
//
// ── WHY THE FACES LIVE HERE AND NOT IN EACH APP ────────────────────────────
// MOTIR-3724 fixed where Motir's BRAND chrome lives for cross-repo reuse: one
// published package both properties install. The glyph's geometry and its baked
// colour literals followed that ruling from day one; the font bytes did not,
// and for a mechanical reason rather than a considered one — this package
// carried no assets, so the second consumer copied them (MOTIR-3848). Three
// binaries with no shared owner cannot diverge by editing, but they diverge by
// OMISSION: `design/brand/design-notes.md` §6 pins the OG template's typeface,
// and a §6 amendment that re-cuts it lands in whichever repository the card is
// pinned to while the other keeps shipping the old face under a green build.
//
// ── WHY THREE FILES ────────────────────────────────────────────────────────
// §6's template uses exactly three weights: 400 for the lede and project
// subtitle, 700 for the wordmark and project name, 800 for the headline. satori
// (what `next/og` renders through) does not synthesise weight — an absent one
// silently snaps to the nearest present face — so shipping fewer would quietly
// re-weight the design.
//
// ── WHY `.ttf` ─────────────────────────────────────────────────────────────
// satori parses TTF / OTF / WOFF; it cannot decompress WOFF2, which is the only
// format Google Fonts serves a modern browser. These are the static Inter v20
// instances Google serves for legacy formats (SIL Open Font License 1.1 — see
// this package's NOTICE).
//
// ⚠️ THIS MODULE EXPORTS THE MANIFEST, NEVER A RESOLVED PATH, AND THAT IS THE
// WHOLE DESIGN. A consumer reads the bytes with `readFile`, and Turbopack's
// tracer only follows such a read when the path is STATICALLY ANALYSABLE — an
// inline `process.env` or a literal `path.join`, never a value returned from a
// function call. A `resolveOgFontPath()` helper exported from here would be
// exactly that function call, and the tracer's fallback for an unresolvable
// read is to trace the ENTIRE project (MOTIR-3219: 4510 files, a 464 MB
// standalone image). So each consumer keeps its own literal join, and this
// manifest is what a test pins those literals against — see
// `motir-core/tests/brand/opengraphImages.test.tsx`.

/** The family name every Motir OG template sets as `fontFamily`. */
export const OG_FONT_FAMILY = 'Inter';

/** One shipped face: the file name inside this package's `fonts/`, and its weight. */
export interface OgFontFace {
  readonly file: string;
  readonly weight: 400 | 700 | 800;
}

/**
 * Every face this package ships for `ImageResponse`'s `fonts` option, in the
 * order the template's weights ascend.
 *
 * The file names are relative to the package's `fonts/` directory, which
 * `package.json` exposes as `@motir/brand/fonts/*` and lists in `files`. A
 * consumer joins them onto its own literal path (see the ⚠️ note above).
 */
export const OG_FONT_FACES: readonly OgFontFace[] = [
  { file: 'Inter-Regular.ttf', weight: 400 },
  { file: 'Inter-Bold.ttf', weight: 700 },
  { file: 'Inter-ExtraBold.ttf', weight: 800 },
] as const;
