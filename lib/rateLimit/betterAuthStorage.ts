import type { BetterAuthOptions } from 'better-auth';
import type { RateLimitStore } from '@/lib/api/v1/rateLimit';
import { hashToken } from '@/lib/apiTokens/token';
import { sharedRateLimitStore } from '@/lib/rateLimit/store';

// BETTER-AUTH'S LIMITER ON THE SHARED COUNTER (Story MOTIR-8547 · MOTIR-8613).
//
// Better-Auth 1.7.7 counts its own buckets — `/sign-in`, `/sign-up`,
// `/change-password`, `/change-email` (3 per 10 s) and our
// `/request-password-reset` rule (3 per 3600 s) — in whatever
// `rateLimit.storage` names, and with neither `storage` nor `secondaryStorage`
// set it defaults to `"memory"`: a module-level `Map` in
// `dist/api/rate-limiter/index.mjs`. On a fleet that is `max × machines`
// (`docs/in-process-state-inventory.md` F1). This adapter is the
// `customStorage` Better-Auth reads FIRST, and it writes through the one store
// every app-level limiter already uses (`sharedRateLimitStore()` → Postgres
// `rate_limit_counter`), so a bucket of 3 is 3 across the fleet.
//
// It is an ADAPTER, not a limiter, exactly as `postgresStore.ts` is: the only
// decision here is `count <= rule.max`. Better-Auth still owns the rule lookup
// and the 429 it answers with.
//
// ⚠️ FIXED WINDOW, NOT BETTER-AUTH'S ROLLING ONE: a caller can spend up to 2 ×
// `max` across one window boundary. That is the counter table's semantics for
// every other limiter, and the price of not adding a second table.
//
// ⚠️ THE KEY IS HASHED. Better-Auth's key carries the client IP; the counter
// table never stores a plaintext identifier (`lib/rateLimit/keys.ts`), so the
// whole key goes through the same `hashToken`. The `ba:` prefix keeps these
// rows apart from the app-level scopes (`auth:sign-in`, …), which keep their own
// budgets on top.
//
// ⚠️ FAIL OPEN. A store that throws or outlives its deadline
// (`RateLimitStoreTimeoutError`) must not become a 500 on every sign-in — the
// same contract `consumeSharedRateLimit` keeps. It is logged and allowed.

/** The prefix of every Better-Auth row in the counter table. */
export const BETTER_AUTH_RATE_LIMIT_PREFIX = 'ba:';

/** Better-Auth's own storage interface, named through its public options type. */
export type BetterAuthRateLimitStorage = NonNullable<
  NonNullable<BetterAuthOptions['rateLimit']>['customStorage']
>;

export interface BetterAuthRateLimitStorageOptions {
  /** The clock, for tests that cross a window boundary. Defaults to `Date.now`. */
  now?: () => number;
}

/** The counter-table key for one of Better-Auth's keys. */
export function betterAuthRateLimitKey(key: string): string {
  return BETTER_AUTH_RATE_LIMIT_PREFIX + hashToken(key);
}

/**
 * A Better-Auth `customStorage` over the shared rate-limit store.
 *
 * The store is resolved per call unless one is passed, so a test override of
 * `sharedRateLimitStore()` reaches it and the env-chosen backend is read once,
 * where every other limiter reads it.
 */
export function createBetterAuthRateLimitStorage(
  store?: RateLimitStore,
  options: BetterAuthRateLimitStorageOptions = {},
): BetterAuthRateLimitStorage {
  const now = options.now ?? Date.now;

  return {
    async consume(key, rule) {
      const at = now();
      const windowMs = rule.window * 1000;
      const windowStart = Math.floor(at / windowMs) * windowMs;
      try {
        const count = await (store ?? sharedRateLimitStore()).increment(
          betterAuthRateLimitKey(key),
          windowStart,
          windowMs,
        );
        if (count <= rule.max) return { allowed: true, retryAfter: null };
        return {
          allowed: false,
          retryAfter: Math.max(1, Math.ceil((windowStart + windowMs - at) / 1000)),
        };
      } catch (err) {
        console.error('[rateLimit] Better-Auth store unavailable; allowing the request', err);
        return { allowed: true, retryAfter: null };
      }
    },
  };
}
