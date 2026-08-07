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
  // The Next.js dev-mode tools indicator renders a fixed portal in the
  // bottom-left corner by default — directly over the app shell's sidebar
  // footer (the collapse toggle). In `next dev` that portal intercepts pointer
  // events on the footer, so a browser-driven E2E click on "Collapse sidebar"
  // is occluded (Subtask 1.5.6's shell-flows spec). The indicator is a dev-only
  // affordance (it never ships to production), so disable it for the E2E dev
  // server — gated on an env flag the Playwright webServer sets, leaving a
  // normal `pnpm dev` session's indicator untouched.
  ...(process.env['E2E_DISABLE_DEV_INDICATOR'] ? { devIndicators: false as const } : {}),

  // ── Keep BUILD-ONLY packages out of every function bundle (MOTIR-2378) ────
  //
  // `app/**` holds 335 serverless functions (252 route handlers + 83 pages),
  // and Next traces each one's dependencies into its OWN bundle. With no
  // excludes declared, anything reachable from a traced module is copied per
  // function — so a package's size is multiplied by 335, not counted once.
  //
  // That is what exhausted the Vercel build container's 32 GB disk (ENOSPC,
  // confirmed by Vercel support 2026-08-07; MOTIR-2371). The final artifacts
  // are small — a real deployment measured node_modules 1215 MB, source 394 MB,
  // output 276 MB — so the 30 GB is intermediate, generated during packaging.
  //
  // ⚠️ EVERY ENTRY HERE MUST BE UNABLE TO EXECUTE AT RUNTIME. An exclude is not
  // a size optimisation, it is an assertion that a serverless function will
  // never load this file — and getting it wrong trades a slow build for
  // production 500s, which is strictly worse because it fails silently in the
  // one environment nobody is watching. Each entry below states why it cannot
  // run in a function.
  //
  // ⚠️ PRISMA IS DELIBERATELY ABSENT. `@prisma/client` is the heaviest
  // candidate at 96 MB installed, and its query engines ARE loaded when a
  // request runs. Excluding it is the obvious next lever and the wrong one to
  // pull from a laptop; if tracing still needs trimming, it gets its own card
  // with a real deployment behind it.
  outputFileTracingExcludes: {
    '**/*': [
      // The Rust compiler that PRODUCES the bundle. 120 MB, build-time only —
      // by the time a function runs, its work is already done.
      './node_modules/.pnpm/@next+swc-*/**',
      // 91 MB dev/test CLI for running the Inngest dev server. The RUNTIME
      // client is the separate `inngest` package, which is NOT excluded.
      './node_modules/.pnpm/inngest-cli@*/**',
      // The E2E browser harness and its driver — test-only, and never imported
      // by anything under `app/` or `lib/`.
      './node_modules/.pnpm/@playwright+test@*/**',
      './node_modules/.pnpm/playwright@*/**',
      './node_modules/.pnpm/playwright-core@*/**',
      // Source maps are read by debuggers, never executed.
      '**/*.js.map',
      '**/*.mjs.map',
      '**/*.d.ts.map',
    ],
  },
};

export default withNextIntl(nextConfig);
