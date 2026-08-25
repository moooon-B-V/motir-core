// The root layout's metadata, and the `metadataBase` every relative
// OpenGraph / Twitter image URL in the product resolves against (MOTIR-2505).
//
// ── Why this is a module and not four lines in `app/layout.tsx` ─────────────
//
// `metadataBase` is the origin Next prepends to a RELATIVE `openGraph.images` /
// `twitter.images` entry when it writes the absolute `<meta property="og:image">`
// value. The file-convention routes
// `app/(public)/explore/(square)/opengraph-image.tsx` and
// `app/(public)/p/[identifier]/opengraph-image.tsx` (MOTIR-1150) are exactly
// such entries: Next injects them as site-relative paths, so with no
// `metadataBase` set it falls back to the dev origin and advertises both cards
// at an address no crawler, social-card renderer or link-preview fetcher can
// reach. It said so on every render, in the Fly logs:
//
//   ⚠ metadataBase property in metadata export is not set for resolving social
//     open graph or twitter images, using "http://localhost:8080"
//
// The origin itself is NOT decided here — `lib/baseUrl.ts` owns that precedence
// for the whole app (MOTIR-2388), and this module is one more caller of it, the
// same way `lib/publicProjects/urls.ts` is for canonicals. Hardcoding an origin
// here would be a second answer to a question that module exists to answer once.
//
// It lives OUTSIDE `app/layout.tsx` for two reasons, both load-bearing:
//
//  1. **The root layout's import graph is measured and constrained.** That file
//     is in every route's module graph — 340 of 348 traced functions already
//     carry `@prisma/client` because of it (MOTIR-2381), and
//     `tests/root-layout-db-imports.test.ts` guards the list. So the import it
//     gains here must be the ZERO-IMPORT leaf `lib/baseUrl.ts`, never
//     `lib/publicProjects/urls.ts` — whose `publicSiteOrigin()` is a one-line
//     delegate to the same function today, but is a domain module free to grow
//     imports tomorrow. Keeping the call here makes that constraint reviewable
//     in one small file instead of buried in a 200-line layout.
//  2. **It makes the value TESTABLE.** `app/layout.tsx` cannot be imported by a
//     unit test — `next/font/google`, `./globals.css` and a Prisma-reaching
//     session read all load with it. `tests/rootMetadata.test.ts` imports this
//     module instead and asserts the resolved origin, so a silent revert to the
//     localhost fallback fails a test rather than adding a line to a log.

import type { Metadata } from 'next';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';

/**
 * The root layout's metadata.
 *
 * ⚠️ Called from `generateMetadata()`, NOT assigned to `export const metadata`.
 * A static `metadata` export is evaluated when the module is loaded, which for a
 * statically-rendered route is BUILD time — and the image build deliberately
 * runs with no `MOTIR_BASE_URL` (the Dockerfile sets only the placeholders
 * module-load checks need, MOTIR-2490). Evaluated there, `resolveBaseUrlTrimmed()`
 * returns the localhost fallback and Next freezes it into the output: a clean
 * build shipping the same bug. `generateMetadata()` is evaluated per request,
 * against the real runtime environment.
 */
export function buildRootMetadata(): Metadata {
  return {
    metadataBase: new URL(resolveBaseUrlTrimmed()),
    title: 'Motir',
    description: 'AI-native project management — open-source PM substrate.',
  };
}
