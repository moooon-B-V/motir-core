import type { NextResponse } from 'next/server';
import { publicReadBudget } from '@/lib/rateLimit/budgets';
import { enforceRateLimit, isRateLimitExcluded } from '@/lib/rateLimit/guard';
import { clientIp, rateLimitKey } from '@/lib/rateLimit/keys';

// App-level limiting for a VISITOR's reads (Story MOTIR-6170 · MOTIR-6642;
// DECISION MOTIR-6165 Q3 — "rate limited per IP"): the Visitor pages at
// `app.motir.co/p/<identifier>/<view>` and the client data doors they fetch from.
//
// ── ONE LIMB, KEYED ON IP ────────────────────────────────────────────────────
// A Visitor needs no account, so the IP is the only identity there is. The scope
// is its own bucket (`public-read`), never `public-write`: a person reading a
// board must not spend the allowance they would use to file a request, and a
// scraper exhausting the read budget must not lock that origin out of writing.
//
// Nothing here is wired to a route — the route tree and the data doors call it.

/**
 * Limit one Visitor read. Returns a 429 to return instead of doing the work, or
 * null to proceed.
 */
export async function enforcePublicReadRateLimit(req: Request): Promise<NextResponse | null> {
  const { pathname } = new URL(req.url);
  if (isRateLimitExcluded(pathname)) return null;

  const { response } = await enforceRateLimit([
    {
      scope: 'public-read',
      key: rateLimitKey('public-read', clientIp(req)),
      budget: publicReadBudget(),
    },
  ]);
  return response;
}
