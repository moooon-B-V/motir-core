import { ApiV1Error } from '@/lib/api/v1/errors';

// Per-TOKEN rate limiting for `/api/v1` (Story 11.1 · Subtask 11.1.4 —
// MOTIR-1860). The one genuinely new primitive in the story: a `grep` over
// `lib/` and `app/` confirms no rate-limit helper existed anywhere (the
// `rateLimit` hits are Better-Auth's own config plus settings copy).
//
// It is FOUNDATION, not hardening to schedule later: an unlimited public API
// over a shared Postgres is a denial-of-service surface. It installs inside the
// shared wrapper, so every `/api/v1` route is limited BY CONSTRUCTION — a new
// route cannot forget to opt in. Pinned in
// `docs/decisions/public-api-conventions.md` §6.
//
// ── Keyed per TOKEN ──────────────────────────────────────────────────────────
// Not per IP (shared NATs, CI runners and corporate proxies collide, so one
// tenant's traffic would refuse another's) and not per USER (one runaway script
// would starve that user's other integrations). Per token means one integration
// cannot exhaust another's budget, and revoking a compromised token stops its
// traffic. The key is the token's sha-256 fingerprint, so nothing here holds a
// plaintext secret.
//
// ── The counter is a READ-DERIVED WRITE, so it is ATOMIC ─────────────────────
// Read → compare → write is the textbook check-then-write race: two concurrent
// requests both read the stale count and both pass, so the limit leaks under
// exactly the concurrent load it exists to control. The store's contract is
// therefore INCREMENT-AND-RETURN-THE-NEW-VALUE as one indivisible step; the
// comparison happens on the value that step returned. `motir-core/CLAUDE.md`'s
// concurrency rule, applied one layer up from the database.

/** Requests per window, per token, when the environment sets no budget. */
export const DEFAULT_RATE_LIMIT = 60;
/** Window length when the environment sets none — 60 requests per minute. */
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

/** 429 — the token's budget for the current window is spent. */
export class RateLimitExceededError extends ApiV1Error {
  constructor(retryAfterSeconds: number) {
    super(
      'RATE_LIMIT_EXCEEDED',
      429,
      `Rate limit exceeded. Retry in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`,
    );
    this.name = 'RateLimitExceededError';
  }
}

/** The budget in force for this deployment. */
export interface RateLimitBudget {
  limit: number;
  windowMs: number;
}

/**
 * Read the budget from the environment on each call, so a deployment can
 * change it without a code change (a self-hoster's ceiling is not Motir
 * Cloud's) and so a test can shrink the window instead of waiting a minute.
 * An unset, non-numeric or non-positive value falls back to the documented
 * default rather than disabling the limiter.
 */
export function rateLimitBudget(): RateLimitBudget {
  return {
    limit: positiveIntEnv('MOTIR_API_V1_RATE_LIMIT', DEFAULT_RATE_LIMIT),
    windowMs: positiveIntEnv('MOTIR_API_V1_RATE_LIMIT_WINDOW_MS', DEFAULT_RATE_LIMIT_WINDOW_MS),
  };
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return parsed > 0 ? parsed : fallback;
}

/**
 * The counter behind the limiter.
 *
 * ⚠️ `increment` MUST be indivisible: it increments the counter for
 * `(key, windowStart)` and returns the NEW value in one step. An implementation
 * that reads, compares and then writes — with or without an `await` between —
 * leaks the limit under concurrency and does not satisfy this contract.
 */
export interface RateLimitStore {
  increment(key: string, windowStart: number, windowMs: number): Promise<number>;
}

/**
 * The default store: an in-process fixed-window counter.
 *
 * The mutation below is SYNCHRONOUS — one expression, no `await` between the
 * read and the write — so on JavaScript's single-threaded event loop it is
 * genuinely indivisible. Two concurrent requests cannot both observe the same
 * pre-increment value.
 *
 * ⚠️ RECORDED LIMITATION — the window is PER PROCESS. Story 11.1 deliberately
 * ships no migration and no new repository, so there is no shared counter yet:
 * on a multi-instance deployment each instance enforces its own window and the
 * effective ceiling is `limit × instances`. That is a real weakening and it is
 * recorded rather than glossed (ADR §6). Everything else — the enforcement
 * seam, the headers, the 429, the atomicity contract and the fail-open
 * behaviour — is correct and permanent; only the STORE is provisional, and
 * swapping in a shared one (Postgres or Redis) implements this same interface
 * and changes no route, no header and no status.
 */
export function createInProcessRateLimitStore(): RateLimitStore {
  const counts = new Map<string, { windowStart: number; count: number }>();

  return {
    async increment(key: string, windowStart: number, windowMs: number): Promise<number> {
      const existing = counts.get(key);
      // One synchronous read-modify-write. A stale window is replaced rather
      // than accumulated, which is what makes the window RESET.
      const next =
        existing && existing.windowStart === windowStart
          ? { windowStart, count: existing.count + 1 }
          : { windowStart, count: 1 };
      counts.set(key, next);

      // Opportunistic sweep so a long-lived process does not retain a row per
      // token forever. Bounded work: only runs once the map is large.
      if (counts.size > 10_000) {
        for (const [k, v] of counts) {
          if (v.windowStart + windowMs < windowStart) counts.delete(k);
        }
      }
      return next.count;
    },
  };
}

let activeStore: RateLimitStore = createInProcessRateLimitStore();

/** Swap the store — the seam a shared-store implementation (or a test) uses. */
export function setRateLimitStore(store: RateLimitStore): void {
  activeStore = store;
}

/** Restore the default in-process store. */
export function resetRateLimitStore(): void {
  activeStore = createInProcessRateLimitStore();
}

/** What the limiter decided, and what the caller should be told about it. */
export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  /** Requests left in this window; never negative. */
  remaining: number;
  /** Unix SECONDS at which the window resets — a time a client can wait for. */
  resetAt: number;
  /** True when the store failed and the request was allowed through anyway. */
  degraded: boolean;
}

/**
 * Spend one request from `fingerprint`'s budget.
 *
 * ⚠️ A store failure MUST NOT fail the request: an outage in the limiter must
 * not take the API down, so it degrades to allowing the call and logs. That is
 * the deliberate trade — a brief over-serve beats an outage caused by the thing
 * meant to protect against one.
 */
export async function consumeRateLimit(fingerprint: string): Promise<RateLimitDecision> {
  const { limit, windowMs } = rateLimitBudget();
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = Math.ceil((windowStart + windowMs) / 1000);

  let used: number;
  try {
    // Atomic: increment and take the NEW count. Nothing compares a value read
    // before this line.
    used = await activeStore.increment(fingerprint, windowStart, windowMs);
  } catch (err) {
    console.error('[api/v1] rate-limit store unavailable; allowing the request', err);
    return { allowed: true, limit, remaining: limit, resetAt, degraded: true };
  }

  return {
    allowed: used <= limit,
    limit,
    remaining: Math.max(0, limit - used),
    resetAt,
    degraded: false,
  };
}

/**
 * The headers a v1 response carries — on EVERY response, not only refusals.
 * A client can only back off politely if it can see its budget while
 * succeeding; headers that appear only on a 429 force clients to discover the
 * limit by hitting it.
 */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  return {
    'x-ratelimit-limit': String(decision.limit),
    'x-ratelimit-remaining': String(decision.remaining),
    'x-ratelimit-reset': String(decision.resetAt),
  };
}

/** Seconds a refused caller should wait, floored at 1. */
export function retryAfterSeconds(decision: RateLimitDecision): number {
  return Math.max(1, decision.resetAt - Math.floor(Date.now() / 1000));
}
