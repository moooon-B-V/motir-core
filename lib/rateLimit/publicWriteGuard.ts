import type { NextResponse } from 'next/server';
import { publicWriteBudget } from '@/lib/rateLimit/budgets';
import { enforceRateLimit, isRateLimitExcluded } from '@/lib/rateLimit/guard';
import { clientIp, rateLimitKey } from '@/lib/rateLimit/keys';

// App-level limiting for the PUBLIC-WRITE surfaces (Subtask 8.5.9 / MOTIR-1165):
// public-project request intake, its duplicate pre-check, and public-request
// comments + upvotes.
//
// ── KEYED ON IP, TIGHTER THAN AUTH ───────────────────────────────────────────
// These are internet-facing writes. They DO require a signed-in account (a write
// on a public project is sign-in-to-act), and there is already a per-ACCOUNT
// throttle inside `publicProjectsService` — but an account is free to create, so
// a per-account ceiling alone is a ceiling on patience, not on abuse. The per-IP
// limb is the one an attacker cannot mint their way around, so the two are
// complementary rather than redundant: the account limb bounds one identity, the
// IP limb bounds one origin.
//
// The budget is tighter than the auth one because nothing here is a thing a human
// does repeatedly — filing a request or upvoting is a considered act, not a
// retried one.

/**
 * Limit one public write. Returns a 429 to return instead of doing the work, or
 * null to proceed.
 */
export async function enforcePublicWriteRateLimit(req: Request): Promise<NextResponse | null> {
  const { pathname } = new URL(req.url);
  if (isRateLimitExcluded(pathname)) return null;

  const { response } = await enforceRateLimit([
    {
      scope: 'public-write',
      key: rateLimitKey('public-write', clientIp(req)),
      budget: publicWriteBudget(),
    },
  ]);
  return response;
}
