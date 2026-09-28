import type { NextResponse } from 'next/server';
import { publicReadBudget } from '@/lib/rateLimit/budgets';
import { enforceRateLimit, isRateLimitExcluded } from '@/lib/rateLimit/guard';
import { rateLimitKey } from '@/lib/rateLimit/keys';

// App-level limiting for a VISITOR's reads (Story MOTIR-6170 · MOTIR-6642,
// MOTIR-6666): the Visitor pages at
// `app.motir.co/p/<identifier>/<view>` and the client data doors they fetch from.
//
// ── ONE LIMB, KEYED ON THE PERSON (MOTIR-6666) ───────────────────────────────
// Every Visitor is signed in and has consented (`visitor-sign-in-and-records.md`),
// so the reader's user id is the identity to budget — one person on a shared
// office IP no longer spends a colleague's allowance, and a second browser does
// not buy a second budget. The scope stays its own bucket (`public-read`), never
// `public-write`: reading must not spend the allowance for filing a request.
//
// Nothing here is wired to a route — the route tree and the data doors call it,
// with the user id of the Visitor `resolveVisitor` answered.

/**
 * Limit one Visitor read by the signed-in reader. Returns a 429 to return instead
 * of doing the work, or null to proceed.
 */
export async function enforcePublicReadRateLimit(
  req: Request,
  userId: string,
): Promise<NextResponse | null> {
  const { pathname } = new URL(req.url);
  if (isRateLimitExcluded(pathname)) return null;

  const { response } = await enforceRateLimit([
    {
      scope: 'public-read',
      key: rateLimitKey('public-read', `user:${userId}`),
      budget: publicReadBudget(),
    },
  ]);
  return response;
}
