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

const nextConfig: NextConfig = {
  // The Next.js dev-mode tools indicator renders a fixed portal in the
  // bottom-left corner by default — directly over the app shell's sidebar
  // footer (the collapse toggle). In `next dev` that portal intercepts pointer
  // events on the footer, so a browser-driven E2E click on "Collapse sidebar"
  // is occluded (Subtask 1.5.6's shell-flows spec). The indicator is a dev-only
  // affordance (it never ships to production), so disable it for the E2E dev
  // server — gated on an env flag the Playwright webServer sets, leaving a
  // normal `pnpm dev` session's indicator untouched.
  ...(process.env['E2E_DISABLE_DEV_INDICATOR'] ? { devIndicators: false as const } : {}),
};

export default withNextIntl(nextConfig);
