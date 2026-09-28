import { notFound } from 'next/navigation';
import { isE2EProdHarness } from '@/lib/e2eProdHarness';

// A TEST-ONLY page that throws during its server render (MOTIR-6855), so the E2E
// spec `tests/e2e/server-error-boundary.spec.ts` can drive state 1 of the
// server-error page — `app/(authed)/error.tsx` — in a real browser. Nothing else
// in the app throws on demand, and a boundary that is never exercised end to end
// is the one that silently stops catching.
//
// URL `/workbench/_render-error`: the on-disk `%5F` is Next's escape for a
// routable segment starting with `_` (a bare `_render-error` folder is private
// and never routed) — the convention `app/api/%5Ftest/*` uses, with the same gate
// (`_helpers.ts` `productionGate`): a real production build answers 404, and only
// the E2E production harness (never a deploy) lets it through.
//
// It is a CHILD of an existing signed-in segment, never a top-level one of its
// own: a new top-level segment is something the auth proxy's matcher and
// `robots.txt` must each cover (`tests/navigation/proxy-matcher.test.ts`,
// `tests/seo/robots-signed-in-coverage.test.ts`), and a test probe earns neither.
// `workbench/` has no layout, loading or error file of its own, so the throw
// reaches `app/(authed)/error.tsx` exactly as a real page's would.

export const dynamic = 'force-dynamic';

export default function RenderErrorProbe(): never {
  if (process.env['NODE_ENV'] === 'production' && !isE2EProdHarness()) notFound();
  throw new Error('render-error probe (MOTIR-6855): a page under (authed) failed to render');
}
