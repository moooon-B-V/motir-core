import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// Wires next-intl's request config (./i18n/request.ts by default) into the build.
const withNextIntl = createNextIntlPlugin();

// PRODECT_FINDINGS #3: `next build`'s "Collecting page data" step evaluates
// every route module — including pure server-handler routes that never touch
// Google — which transitively imports `lib/auth/index.ts` and runs its
// module-level `requiredEnv('GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET')`.
// A dev/CI/worktree checkout whose `.env` carries only DATABASE_URL then
// fails the build with a confusing "Failed to collect page data" error on a
// route that has zero coupling to Google.
//
// Fix: seed placeholder OAuth creds here so module-load `requiredEnv` checks
// pass during dev and `next build`. This file is evaluated by `next dev`,
// `next build`, AND the production server, so the injection MUST be gated to
// non-production — otherwise a genuinely-missing prod credential would be
// silently papered over with a placeholder instead of failing loud at the
// first /api/auth request (the property finding #3 explicitly wants to keep).
//
// The placeholders are inert build-time stand-ins: they only let module-load
// `requiredEnv` checks pass during `next build`'s page-data collection. They
// never authenticate against Google (no OAuth round-trip happens during a
// build). Gated to non-production so a production deploy that genuinely lacks
// the creds still fails loud at the first /api/auth request.
//
// This is purely a LOCAL build-DX fix and changes nothing on Vercel: both
// Production AND Preview targets carry real GOOGLE_CLIENT_ID/SECRET, so the
// `??=` never overwrites anything there. The branch only fires in local
// `git worktree` / CI builds whose hand-copied `.env` omits the OAuth vars
// (the scenario in PRODECT_FINDINGS #3) — those have NODE_ENV development/test,
// get placeholders, and `next build` collects page data cleanly instead of
// throwing on routes (e.g. /api/invites/[token]/accept) that never touch Google.
if (process.env['NODE_ENV'] !== 'production') {
  process.env['GOOGLE_CLIENT_ID'] ??= 'build-time-placeholder-client-id';
  process.env['GOOGLE_CLIENT_SECRET'] ??= 'build-time-placeholder-client-secret';
  process.env['BETTER_AUTH_SECRET'] ??= 'build-time-placeholder-secret-32-bytes-minimum';
}

/**
 * The documentation area moved from `/api-docs` to `/docs` (MOTIR-2286 · ADR
 * `public-api-conventions.md` Amendment 9 Q1), so every address it ever served
 * keeps working — PERMANENTLY.
 *
 * `permanent: true` is a 308, which is the point: a 307 tells a crawler and a
 * bookmark to keep asking the old address forever, and the whole reason the area
 * was renamed one day after it shipped is that a URL is a promise to strangers.
 *
 * The order matters. Next matches these top-to-bottom, and `/api-docs/:path*`
 * would swallow the bare `/api-docs` only if `:path*` matched empty — it does,
 * so the exact rule is declared FIRST and the reference keeps its own
 * destination (`/docs/api`) rather than landing on the area root.
 *
 * The LAST entry exists because the reference deliberately does NOT own the
 * area root: `/docs` is a directory, not a page, and a reader who trims the URL
 * should land on the reference rather than a 404. (Whether it should keep
 * landing there is Amendment 11's one recorded open question — MOTIR-2315.)
 *
 * Exported separately from `nextConfig` so `tests/api-docs/docs-redirects.test.ts`
 * can assert the map without booting a server.
 */
export const DOCS_REDIRECTS = [
  // ── MOTIR-2312 / ADR Amendment 11 Q3 ──────────────────────────────────────
  // The API's guide and policy moved INSIDE the reference's own prefix, so the
  // two `/api-docs/*` addresses that pointed at them get their own exact rules
  // AHEAD of the wildcard below. Without these they would still resolve, but in
  // TWO hops (`/api-docs/stability` → `/docs/stability` → `/docs/api/stability`),
  // and a chain is a thing that breaks one rule at a time.
  {
    source: '/api-docs/getting-started',
    destination: '/docs/api/getting-started',
    permanent: true,
  },
  { source: '/api-docs/stability', destination: '/docs/api/stability', permanent: true },
  { source: '/api-docs', destination: '/docs/api', permanent: true },
  { source: '/api-docs/:path*', destination: '/docs/:path*', permanent: true },
  // The addresses those two pages served between Amendment 9 and Amendment 11.
  { source: '/docs/getting-started', destination: '/docs/api/getting-started', permanent: true },
  { source: '/docs/stability', destination: '/docs/api/stability', permanent: true },
  { source: '/docs', destination: '/docs/api', permanent: true },
] as const;

const nextConfig: NextConfig = {
  async redirects() {
    return [...DOCS_REDIRECTS];
  },
  // The two `next/og` cards read Inter's bytes off disk at request time
  // (`app/_brand/ogFonts.ts` — satori has no CSS tree and no system font stack,
  // so `ImageResponse`'s `fonts` option is the ONLY way a card gets a typeface).
  // A `readFile(join(process.cwd(), …))` is the kind of read a bundler's static
  // analysis can miss, and a font that is absent from the deployed function does
  // not error — the card falls back to a face nobody chose, invisibly, because
  // locally the file is always there. Naming the directory declares the intent.
  //
  // ⚠️ This key does NOT currently do anything, and the fonts arrive anyway —
  // both halves verified, MOTIR-2403. `outputFileTracingIncludes` /
  // `outputFileTracingExcludes` are read in exactly one place,
  // `next/dist/build/collect-build-traces.js`, and `next/dist/build/index.js`
  // guards that call with `if (bundler !== Bundler.Turbopack && …)`. Next 16
  // builds with Turbopack, so the module never runs and neither key is consulted.
  // Turbopack's own tracer follows the read on its own: the three TTFs appear in
  // `.next/server/app/(public)/explore/opengraph-image-*/route.js.nft.json` and
  // in no unrelated route's trace.
  //
  // It is kept, rather than deleted, because it is the only written record of
  // WHY those bytes must ship, and it is the safety net on the webpack path
  // (`next build --webpack`, which CI still has available). Anything that
  // depends on it taking effect must not assume this build applies it.
  outputFileTracingIncludes: {
    '/explore/opengraph-image': ['./app/_brand/fonts/**'],
    '/p/[identifier]/opengraph-image': ['./app/_brand/fonts/**'],
  },
  // The Next.js dev-mode tools indicator renders a fixed portal in the
  // bottom-left corner by default — directly over the app shell's sidebar
  // footer (the collapse toggle). In `next dev` that portal intercepts pointer
  // events on the footer, so a browser-driven E2E click on "Collapse sidebar"
  // is occluded (Subtask 1.5.6's shell-flows spec). The indicator is a dev-only
  // affordance (it never ships to production), so disable it for the E2E dev
  // server — gated on an env flag the Playwright webServer sets, leaving a
  // normal `pnpm dev` session's indicator untouched.
  ...(process.env['E2E_DISABLE_DEV_INDICATOR'] ? { devIndicators: false as const } : {}),
  output: 'standalone',

  // ⚠️ There is deliberately NO `outputFileTracingExcludes` here, and the
  // pruning it used to claim lives in the `Dockerfile`'s BUILDER stage instead
  // (MOTIR-2403). This file used to carry
  //
  //     outputFileTracingExcludes: { '**/*': ['./design/**', './tests/**', …] }
  //
  // with a comment stating a measured size, and it removed nothing. The key is
  // consulted only by `next/dist/build/collect-build-traces.js`, which
  // `next/dist/build/index.js` calls behind
  // `if (bundler !== Bundler.Turbopack && …)` — so under Next 16's Turbopack
  // build the whole module is skipped and the key is inert. Measured on a clean
  // build at `origin/main`: `.next/standalone` = 381 MB, of which `design/` was
  // 222 MB, every directory the exclusion named still present, and all 324
  // `design/` files reachable from one trace (`instrumentation.js.nft.json`).
  //
  // Re-adding an exclusion here will not shrink anything while this repo builds
  // with Turbopack. If that ever changes, the Dockerfile step is written to fail
  // loudly rather than quietly stop mattering.
};

export default withNextIntl(nextConfig);
