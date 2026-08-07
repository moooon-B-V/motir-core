import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Inter, for the two `next/og` cards (MOTIR-1150 · design/brand/design-notes.md
// §6 "fonts"). Both OG routes said `fontFamily: 'sans-serif'` until this card,
// so the shipped cards were set in whatever face the build container happened to
// ship — a real inconsistency between the share card and the site it advertises.
//
// `next/og` renders through satori, OUTSIDE the CSS tree: it cannot read
// `--font-sans-source`, cannot see `next/font`'s output, and has no system font
// stack to fall back to. The only way it gets a typeface is `ImageResponse`'s
// `fonts` option, and the only thing that option accepts is font BYTES — so the
// faces are committed beside this file and read at request time.
//
// WHY THREE FILES. The template uses exactly three weights: 400 for the lede and
// project subtitle, 700 for the wordmark and project name, 800 for the headline.
// satori does not synthesise weight — an absent one silently snaps to the
// nearest present face — so shipping fewer would quietly re-weight the design.
//
// WHY `.ttf`. satori parses TTF / OTF / WOFF; it cannot decompress WOFF2, which
// is the only format Google Fonts serves a modern browser. These are the static
// Inter v20 instances Google serves for legacy formats (SIL Open Font License).
//
// ⚠️ `process.cwd()` + `readFile` is invisible to Next's dependency tracer, so
// `next.config.ts` names this directory in `outputFileTracingIncludes` for both
// OG routes. If a card ever renders in the wrong face on Vercel while it is
// correct locally, that entry is the first thing to check.

const FONT_DIR = path.join(process.cwd(), 'app', '_brand', 'fonts');

const FACES = [
  { file: 'Inter-Regular.ttf', weight: 400 as const },
  { file: 'Inter-Bold.ttf', weight: 700 as const },
  { file: 'Inter-ExtraBold.ttf', weight: 800 as const },
];

/** The family name both OG templates set as `fontFamily`. */
export const OG_FONT_FAMILY = 'Inter';

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
    FACES.map(async ({ file, weight }) => ({
      name: OG_FONT_FAMILY,
      data: await readFile(path.join(FONT_DIR, file)),
      weight,
      style: 'normal' as const,
    })),
  );
}
