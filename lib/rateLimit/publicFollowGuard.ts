import type { NextResponse } from 'next/server';
import { publicFollowBudget } from '@/lib/rateLimit/budgets';
import { enforceRateLimit, isRateLimitExcluded } from '@/lib/rateLimit/guard';
import { clientIp, rateLimitKey } from '@/lib/rateLimit/keys';

// App-level limiting for the public FOLLOW surfaces (Story 8.9 · Subtask 8.9.5 ·
// `docs/decisions/public-follow-and-changelog.md` §7).
//
// ── TWO BUCKETS, BECAUSE THERE ARE TWO ATTACKS ──────────────────────────────
// The sibling `publicWriteGuard` keys on IP alone, which is right for a write
// that requires sign-in. The email opt-in requires no account and SENDS MAIL to
// an address the caller supplies, so one key stops only half of what can be
// done with it:
//
//   * ONE IP, MANY ADDRESSES — someone walking a list to discover which of them
//     have Motir accounts, or simply to make us send mail. The IP key bounds it.
//   * MANY IPs, ONE ADDRESS — mail-bombing one person through us, from a botnet
//     or a proxy pool, where every request looks like a different origin. Only
//     the ADDRESS key bounds that, and it is the attack whose cost lands on
//     somebody who never visited the site.
//
// `enforceRateLimit` takes both limbs and refuses if EITHER is exhausted, so the
// two compose without either weakening the other. The address is hashed into the
// key by `rateLimitKey` (each component individually), so the counter table
// never holds an address in the clear.
//
// ⚠️ IT HONOURS `E2E_DISABLE_RATE_LIMIT` THROUGH THE SHARED HELPER, and does not
// introduce a second env var. The Playwright configs set that one flag; a
// limiter that ignores it breaks every spec that drives more than one visitor
// from localhost, and the failure looks like an unrelated bug.

/**
 * Limit one follow / subscribe write. Pass the submitted `email` on the opt-in
 * path so the per-address limb engages; omit it for the account toggle, which
 * has no address to bound.
 *
 * Returns a 429 to return instead of doing the work, or null to proceed.
 */
export async function enforcePublicFollowRateLimit(
  req: Request,
  email?: string,
): Promise<NextResponse | null> {
  const { pathname } = new URL(req.url);
  if (isRateLimitExcluded(pathname)) return null;

  const budget = publicFollowBudget();
  const limbs = [
    { scope: 'public-follow' as const, key: rateLimitKey('public-follow', clientIp(req)), budget },
  ];
  if (email) {
    limbs.push({
      scope: 'public-follow' as const,
      key: rateLimitKey('public-follow', `email:${email}`),
      budget,
    });
  }

  const { response } = await enforceRateLimit(limbs);
  return response;
}
