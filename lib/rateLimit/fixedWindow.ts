import type { RateLimitScope } from '@/lib/rateLimit/keys';
import { rateLimitKey } from '@/lib/rateLimit/keys';
import { consumeSharedRateLimit } from '@/lib/rateLimit/limiter';
import { retryAfterSeconds } from '@/lib/api/v1/rateLimit';

// The small fixed-window helper the pre-8.5.9 surfaces call (the change-password
// action, the public idea-draft receiver).
//
// ⚠️ IT NO LONGER OWNS A COUNTER. This module used to hold its own in-memory
// `Map<string, Bucket>` — a SECOND in-process store implementation beside
// `createInProcessRateLimitStore`, with the recorded consequence that limits were
// PER SERVER INSTANCE and an attacker spread across instances got
// `max x instances`. Subtask 8.5.9 (MOTIR-1165) landed one shared store for the
// whole app, so this is now a thin adapter over it: the callers keep the shape
// they already had, and their ceilings become real across both Fly machines
// without either call site changing its policy.
//
// Kept as its own function rather than folded into `consumeSharedRateLimit`
// because these two callers express their budget INLINE (a constant beside the
// call) instead of drawing it from `lib/rateLimit/budgets.ts` — that is a
// legitimate shape for a one-off surface, and this preserves it while removing
// the duplicate store. The result type stays `retryAfterMs` for the same reason:
// both callers already compute their response from it.

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the window resets (0 when allowed). */
  retryAfterMs: number;
}

/**
 * Record an attempt against `scope` + `components` and report whether it is
 * allowed. Counts the current attempt: with `max = 5`, the 6th call inside the
 * window is rejected.
 *
 * Components are hashed into the key (`rateLimitKey`), so a user id or an IP
 * never reaches the counter table in the clear — the same obligation ADR §7 puts
 * on every key this store holds.
 *
 * Fails OPEN on a store failure, like every other limiter in the app: the arm
 * lives in `consumeSharedRateLimit`, so an unreachable or hung database allows
 * the request rather than locking the user out of changing their password.
 */
export async function consumeRateLimit(
  scope: RateLimitScope,
  components: string[],
  max: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const decision = await consumeSharedRateLimit(rateLimitKey(scope, ...components), {
    limit: max,
    windowMs,
  });
  if (decision.allowed) return { allowed: true, retryAfterMs: 0 };
  return { allowed: false, retryAfterMs: retryAfterSeconds(decision) * 1000 };
}
