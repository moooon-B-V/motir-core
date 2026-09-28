import { notFound } from 'next/navigation';
import { isE2EProdHarness } from '@/lib/e2eProdHarness';

// A TEST-ONLY page that throws during its server render (MOTIR-6855), so the E2E
// spec `tests/e2e/server-error-boundary.spec.ts` can drive state 1 of the
// server-error page — `app/(authed)/error.tsx` — in a real browser. Nothing else
// in the app throws on demand, and a boundary that is never exercised end to end
// is the one that silently stops catching.
//
// URL `/_test/render-error`: the on-disk `%5Ftest` is Next's escape for a
// routable segment starting with `_` (a bare `_test` folder is private and never
// routed) — the same convention and the same gate as `app/api/%5Ftest/*`
// (`_helpers.ts` `productionGate`): a real production build answers 404, and
// only the E2E production harness (never a deploy) lets it through.

export const dynamic = 'force-dynamic';

export default function RenderErrorProbe(): never {
  if (process.env['NODE_ENV'] === 'production' && !isE2EProdHarness()) notFound();
  throw new Error('render-error probe (MOTIR-6855): a page under (authed) failed to render');
}
