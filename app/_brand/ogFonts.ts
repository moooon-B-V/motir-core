import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OG_FONT_FAMILY } from '@motir/brand';

// Inter, for the two `next/og` cards (MOTIR-1150 · design/brand/design-notes.md
// §6 "fonts"). Both OG routes said `fontFamily: 'sans-serif'` until that card,
// so the shipped cards were set in whatever face the build container happened to
// ship — a real inconsistency between the share card and the site it advertises.
//
// `next/og` renders through satori, OUTSIDE the CSS tree: it cannot read
// `--font-sans-source`, cannot see `next/font`'s output, and has no system font
// stack to fall back to. The only way it gets a typeface is `ImageResponse`'s
// `fonts` option, and the only thing that option accepts is font BYTES — so the
// faces are read off disk at request time.
//
// ⚠️ THE BYTES LIVE IN `@motir/brand`, NOT BESIDE THIS FILE (MOTIR-3848). They
// were committed here AND in motir-marketing — three binaries, byte-identical,
// with no shared owner, against MOTIR-3724's own ruling that Motir's brand
// chrome has ONE home across both properties. The two copies could not diverge
// by editing (nobody hand-edits a TTF); they would have diverged by OMISSION,
// the day a §6 amendment re-cut the typeface in whichever repository the card
// happened to be pinned to. `packages/brand/src/ogFonts.ts` carries the WHY
// THREE FILES and WHY `.ttf` reasoning with the bytes.
//
// ⚠️ EVERY SEGMENT OF `FONT_DIR` IS A LITERAL, AND `OG_FONT_FACES` IS A LOCAL
// ARRAY OF LITERALS — BOTH DELIBERATELY. Turbopack traces a `readFile` only when
// it can resolve the path STATICALLY; its fallback for a path it cannot resolve
// is to trace the ENTIRE project into this route's `.nft.json` (MOTIR-3219: 4510
// files, a 464 MB standalone image). So the package exports a MANIFEST and never
// a path helper: `resolveOgFontPath()` would be exactly the function call that
// defeats the tracer. The local literals are pinned against the package's
// `OG_FONT_FACES` by `tests/brand/opengraphImages.test.tsx`, so a face added or
// re-cut in the package fails a test here rather than silently re-weighting a
// card nobody looks at.
//
// ⚠️ AND IT IS `packages/brand/fonts`, NOT `node_modules/@motir/brand/fonts` —
// motir-marketing READS THE OTHER ONE, AND BOTH ARE RIGHT. This is the one thing
// the move could have shipped broken, invisibly, so it is written down with the
// measurement rather than left to look like an inconsistency:
//
//   - Here `@motir/brand` is a WORKSPACE package. `node_modules/@motir/brand` is
//     a symlink to `../../packages/brand`, which points OUTSIDE `node_modules`,
//     and `copyTracedFiles` reproduces the traced files at their RESOLVED path
//     without re-creating that symlink. Measured on this repo's own
//     `next build`: `.next/standalone/packages/brand/fonts/*.ttf` present,
//     `.next/standalone/node_modules/@motir/brand/` ABSENT ENTIRELY. Reading
//     through node_modules would therefore resolve in dev, in test and in CI,
//     and ENOENT only in the deployed image.
//   - In motir-marketing it is an INSTALLED package, so both
//     `node_modules/.pnpm/@motir+brand@…/…/fonts/` and the top-level
//     `node_modules/@motir/brand/fonts/` land in its standalone output —
//     measured the same way, on that repository's own build.
//
// The shared thing is the PACKAGE, not the string: one owner for the bytes, and
// each consumer naming the path its own layout actually produces. If this ever
// needs re-checking, the check is `find .next/standalone -path '*brand*fonts*'`
// after a build — never a reading of the resolver's rules.
//
// ⚠️ `next.config.ts` still names the directory in `outputFileTracingIncludes`,
// and that key is INERT under Next 16's Turbopack build (MOTIR-2403) — it is the
// webpack-path net, not what ships the bytes. Verify delivery by grepping
// `.next/server/app/**/opengraph-image*/route.js.nft.json`, never by reading the
// config: a dead include reads exactly like a delivered asset.

const FONT_DIR = path.join(process.cwd(), 'packages', 'brand', 'fonts');

/**
 * The faces this app loads, as literals the tracer can follow.
 *
 * Kept in step with `@motir/brand`'s `OG_FONT_FACES` by a test rather than by an
 * import, for the reason in the header. Exported so that test can read it.
 */
export const OG_FONT_FACES = [
  { file: 'Inter-Regular.ttf', weight: 400 as const },
  { file: 'Inter-Bold.ttf', weight: 700 as const },
  { file: 'Inter-ExtraBold.ttf', weight: 800 as const },
];

/** The family name both OG templates set as `fontFamily` — the package owns it. */
export { OG_FONT_FAMILY };

export interface OgFont {
  name: string;
  data: Buffer;
  weight: 400 | 700 | 800;
  style: 'normal';
}

/**
 * The `fonts` array for `new ImageResponse(..., { fonts })`.
 *
 * Read per request rather than cached at module scope: an OG route is rendered
 * rarely and by a cold function most times it is hit, so a module-level cache
 * buys nothing and would pin ~1 MB in every warm instance of a route that also
 * serves nothing else.
 */
export async function loadOgFonts(): Promise<OgFont[]> {
  return Promise.all(
    OG_FONT_FACES.map(async ({ file, weight }) => ({
      name: OG_FONT_FAMILY,
      data: await readFile(path.join(FONT_DIR, file)),
      weight,
      style: 'normal' as const,
    })),
  );
}
