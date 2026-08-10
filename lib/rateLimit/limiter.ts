import type { RateLimitBudget, RateLimitDecision } from '@/lib/api/v1/rateLimit';
import { sharedRateLimitStore } from '@/lib/rateLimit/store';

// The app-level limiter (Subtask 8.5.9 / MOTIR-1165) — one function, the shared
// store, a caller-supplied budget.
//
// It mirrors `/api/v1`'s `consumeRateLimit` exactly (same fixed window, same
// `RateLimitDecision`, same fail-open arm) and differs in one way only: the
// budget is a PARAMETER rather than read from v1's env pair, because the surface
// classes have different ceilings while sharing one counter (ADR §6). The
// headers and the `Retry-After` computation are v1's shipped helpers, reused
// verbatim — a second copy would be free to drift on the one thing clients
// actually parse.

/**
 * The opt-in switch that disables app-level limiting, honoured NOWHERE but here
 * and in Better-Auth's own config.
 *
 * ⚠️ THIS EXISTS FOR THE E2E SUITE AND IT IS LOAD-BEARING. Playwright signs up
 * and signs in SEVERAL users from localhost — one IP — inside a few seconds, so
 * an IP-keyed auth limiter would 429 the second user and flake the spec. That is
 * exactly why `lib/auth/index.ts` already gates Better-Auth's limiter on this
 * same flag, and the app-level limiter has to honour the SAME one rather than
 * introduce a second switch: two flags means a suite that sets one and flakes on
 * the other.
 *
 * It is opt-IN (default: limiter ON) and set ONLY in `playwright.config.ts`'s
 * `webServer.env`, so a production box with `NODE_ENV` unset cannot accidentally
 * ship with rate limiting off.
 */
export const RATE_LIMIT_DISABLE_ENV = 'E2E_DISABLE_RATE_LIMIT';

/** True when this process has deliberately opted out of app-level limiting. */
export function rateLimitingDisabled(): boolean {
  return process.env[RATE_LIMIT_DISABLE_ENV] === '1';
}

/** The decision a disabled limiter reports: allowed, full budget, not degraded. */
function allowUnlimited(budget: RateLimitBudget, resetAt: number): RateLimitDecision {
  return {
    allowed: true,
    limit: budget.limit,
    remaining: budget.limit,
    resetAt,
    degraded: false,
  };
}

/**
 * Spend one request from `key`'s budget.
 *
 * ⚠️ A STORE FAILURE MUST NOT FAIL THE REQUEST. The store is now a shared
 * dependency in the path of every limited request, so this arm matters more than
 * it did for an in-process Map: an outage in the limiter must never be an outage
 * in the product. Both failure shapes land here — a store that THROWS (the
 * database is unreachable) and a store that HANGS (the deadline in
 * `postgresStore.ts` rejects on its behalf) — and both allow the request through
 * with `degraded: true`. Only a genuine over-limit fails closed.
 *
 * A brief over-serve beats an outage caused by the thing meant to prevent one.
 */
export async function consumeSharedRateLimit(
  key: string,
  budget: RateLimitBudget,
): Promise<RateLimitDecision> {
  const now = Date.now();
  const windowStart = Math.floor(now / budget.windowMs) * budget.windowMs;
  const resetAt = Math.ceil((windowStart + budget.windowMs) / 1000);

  if (rateLimitingDisabled()) return allowUnlimited(budget, resetAt);

  let used: number;
  try {
    // Atomic: increment and take the NEW count. Nothing compares a value read
    // before this line.
    used = await sharedRateLimitStore().increment(key, windowStart, budget.windowMs);
  } catch (err) {
    console.error('[rateLimit] store unavailable; allowing the request', err);
    return { allowed: true, limit: budget.limit, remaining: budget.limit, resetAt, degraded: true };
  }

  return {
    allowed: used <= budget.limit,
    limit: budget.limit,
    remaining: Math.max(0, budget.limit - used),
    resetAt,
    degraded: false,
  };
}
