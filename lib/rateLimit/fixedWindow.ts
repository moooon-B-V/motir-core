// Minimal in-memory fixed-window rate limiter.
//
// Scope & guarantee: this matches the protection class the app already relies
// on — Better-Auth's rate limiter defaults to in-memory ("storage: memory")
// storage in this codebase (lib/auth/index.ts sets only `enabled` +
// `customRules`, no DB storage), so limits are PER SERVER INSTANCE. On a
// multi-instance/serverless deployment a determined attacker spread across
// instances gets `max × instances`; that's an accepted v1 trade-off, identical
// to the shipped reset-password limiter. Keys SHOULD be the authenticated
// user id for in-app actions (more precise than per-IP, and not spoofable from
// the client) — e.g. `change-password:<userId>`.
//
// The window is fixed (not sliding): the first request in a key's window
// starts a timer; the (max+1)-th request within `windowMs` is rejected; once
// the window elapses the counter resets. Good enough for "slow the brute
// force" without the bookkeeping of a sliding log.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the window resets (0 when allowed/fresh). */
  retryAfterMs: number;
}

/**
 * Record an attempt against `key` and report whether it is allowed. Counts the
 * current attempt: with `max = 5`, the 6th call inside the window is rejected.
 */
export function consumeRateLimit(
  key: string,
  max: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  const existing = buckets.get(key);

  if (!existing || now >= existing.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (existing.count >= max) {
    return { allowed: false, retryAfterMs: existing.resetAt - now };
  }

  existing.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

/** Test-only: clear all buckets so cases don't leak window state into each other. */
export function __resetRateLimitsForTest(): void {
  buckets.clear();
}
