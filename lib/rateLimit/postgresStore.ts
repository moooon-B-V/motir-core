import type { RateLimitStore } from '@/lib/api/v1/rateLimit';
import { rateLimitService } from '@/lib/services/rateLimitService';

// The POSTGRES `RateLimitStore` (Subtask 8.5.9 / MOTIR-1165) — the shared,
// multi-instance backend for every limiter in the app, pinned in
// `docs/decisions/production-service-stack.md` §6.
//
// It is an ADAPTER, not a limiter: it implements the one-method interface that
// already ships in `lib/api/v1/rateLimit.ts` and delegates the write to the
// service. Nothing here decides whether a request is allowed — the caller
// compares the returned count against its own budget.
//
// ── WHY POSTGRES AND NOT REDIS ───────────────────────────────────────────────
// motir-core runs long-lived Fly processes that already hold an open Postgres
// pool and use it on essentially every request, so the database answers the
// counter question in one round trip. Redis would add a vendor, a bill, a
// subprocessor and a failure domain in front of every request to answer the same
// question. Redis remains the named alternative behind MEASURED triggers (ADR
// §6); `redis` is deliberately not a value this code accepts.
//
// ── THE HARD TIMEOUT IS PART OF THE CONTRACT ─────────────────────────────────
// A shared store puts a dependency in the path of every limited request, so the
// fail-open arm matters MORE than it did for an in-process Map, not less. A
// `catch` alone is not enough: a store that HANGS never throws, so without a
// deadline it would hold the request open indefinitely — the limiter becoming
// the outage it exists to prevent. The timeout rejects, the caller's `catch`
// treats that exactly like any other store failure, and the request proceeds.

/** How long the counter write gets before the limiter gives up on it. */
export const DEFAULT_RATE_LIMIT_STORE_TIMEOUT_MS = 250;

/** Thrown when the counter write outlives its deadline. Always failed OPEN. */
export class RateLimitStoreTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The rate-limit store did not answer within ${timeoutMs}ms.`);
    this.name = 'RateLimitStoreTimeoutError';
  }
}

export interface PostgresRateLimitStoreOptions {
  /** Deadline for one increment. Defaults to {@link DEFAULT_RATE_LIMIT_STORE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Race `work` against a deadline.
 *
 * The timer is always cleared, including on the happy path, so a settled request
 * cannot leave a pending timer holding the event loop open.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  // Assigned synchronously by the Promise executor below, before the `await`, so
  // the `finally` always has a real handle — no guard needed, and `clearTimeout`
  // is a no-op on an already-fired timer anyway.
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RateLimitStoreTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The shared Postgres-backed store.
 *
 * ⚠️ A rejected promise here is the fail-open signal, and the CALLER owns that
 * arm (`consumeSharedRateLimit` / `consumeRateLimit`). This module deliberately
 * does not swallow the error itself: a store that silently returned `0` would be
 * indistinguishable from a genuinely empty window, so the failure has to be
 * visible to the one place that logs it and marks the decision `degraded`.
 */
export function createPostgresRateLimitStore(
  options: PostgresRateLimitStoreOptions = {},
): RateLimitStore {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RATE_LIMIT_STORE_TIMEOUT_MS;

  return {
    async increment(key: string, windowStart: number, windowMs: number): Promise<number> {
      return withDeadline(rateLimitService.increment(key, windowStart, windowMs), timeoutMs);
    },
  };
}
