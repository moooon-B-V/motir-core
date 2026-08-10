import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

// Per-page `<title>` and description for the documentation area (Bug
// MOTIR-2526, under MOTIR-2315).
//
// ── The defect this exists to close ─────────────────────────────────────────
// `app/(public)/docs/layout.tsx` exported the ONLY `generateMetadata` in the
// tree, and every page inherited it. That was correct while the area was the
// API reference and nothing else; three surfaces arrived since, each adding a
// page and none adding a title, so `/docs/sandbox`, `/docs/cli`, `/docs/mcp`
// and `/docs/mcp/tools` all published **"Motir API reference"** — in the browser
// tab, in search results, in a shared link's preview, and to a screen reader on
// arrival. Four places a reader meets a page BEFORE its content, all saying it
// is about something it is not.
//
// Nothing failed, and nothing could have: the shell supplies a title, so every
// page had one. It is invisible from inside the product and visible only from
// outside it.
//
// ── THE PATTERN, chosen once and applied to all of them ─────────────────────
//
//     <page> · Motir docs                     — a page that IS a surface
//     <page> · <surface> · Motir docs         — a page INSIDE a surface
//
// So: "Agent sandbox · Motir docs", and "Getting started · API reference ·
// Motir docs". The middle segment appears exactly when the page is not itself
// the surface — which is the same fact the rail's second tier is gated on
// (ADR `public-api-conventions.md` Amendment 11 Q1), read one layer out.
//
// The strings are authored WHOLE in the catalogs rather than composed here from
// parts. Composition would put an English word order into code and hand a
// translator three fragments and a separator; the `zh` catalog is then free to
// order and punctuate its own way.
//
// ── The area's default is now the AREA's ────────────────────────────────────
// `apiDocs.metaTitle` / `metaDescription` — still the layout's, still the
// fallback — carry the AREA's identity ("Motir documentation") rather than the
// API reference's, which moved to `metaTitleReference` / `metaDescriptionReference`
// with `/docs/api` where they always belonged. A page added tomorrow without a
// title therefore inherits something TRUE, and `tests/api-docs/docs-page-metadata.test.ts`
// fails if it inherits at all.

/**
 * Resolve one page's metadata from the `apiDocs` catalog.
 *
 * Pages call this from their own `generateMetadata` export rather than getting
 * it implicitly, so "this page has a title" stays a visible, greppable fact per
 * page — which is what the guard test reads.
 */
export async function docsPageMetadata(
  titleKey: string,
  descriptionKey: string,
): Promise<Metadata> {
  const t = await getTranslations('apiDocs');
  return {
    title: t(titleKey),
    description: t(descriptionKey),
  };
}
