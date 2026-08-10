import { ApiV1Error } from '@/lib/api/v1/errors';
import { sharedRateLimitStore } from '@/lib/rateLimit/store';

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
//
// ── The counter is SHARED across instances (MOTIR-2037) ──────────────────────
// The store defaults to `sharedRateLimitStore()` — the Postgres counter table
// pinned in `docs/decisions/production-service-stack.md` §6 and built by
// MOTIR-1165, which the auth / public-write / AI limiters already write to.
// Before that it was an in-process Map, so every machine kept its own window
// and a token advertised 60 requests a minute actually got `60 × instances`
// (`× 2` on today's Fly pool). Nothing else about this file moved: the seam, the
// per-token key, the headers, the 429 and the fail-open arm are all unchanged,
// which is exactly what a store BEHIND AN INTERFACE was for.
//
// ⚠️ The fail-open arm below therefore matters MORE than it did, not less: the
// counter is now a shared dependency in the path of every v1 request. A store
// that throws is caught here; a store that HANGS is bounded by the deadline in
// `lib/rateLimit/postgresStore.ts`, which rejects on the store's behalf so the
// same `catch` releases the request. The limiter must never become the outage.
//
// ⚠️ IMPORT CYCLE, deliberate and safe: `lib/rateLimit/store.ts` imports
// `createInProcessRateLimitStore` + `RateLimitStore` from THIS file (it owns the
// `memory` arm and the interface), and this file imports `sharedRateLimitStore`
// back. Neither reference is evaluated at module scope — each sits inside a
// function body, and function declarations hoist — so whichever module the
// bundler enters first finishes initialising before either is called. Do not
// "fix" it by moving the resolution to module load; that is what would break.

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

/**
 * Read a positive integer from the environment, falling back on anything unset,
 * non-numeric or non-positive.
 *
 * Exported because the app-level budgets (`lib/rateLimit/budgets.ts`,
 * MOTIR-1165) resolve their own env names with the SAME semantics — most
 * importantly the same refusal to let a malformed value DISABLE a limiter. A
 * second copy of these four lines would be free to drift on exactly that point.
 */
export function positiveIntEnv(name: string, fallback: number): number {
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
 * The IN-PROCESS fixed-window counter — the `memory` backend.
 *
 * The mutation below is SYNCHRONOUS — one expression, no `await` between the
 * read and the write — so on JavaScript's single-threaded event loop it is
 * genuinely indivisible. Two concurrent requests cannot both observe the same
 * pre-increment value.
 *
 * ⚠️ ITS WINDOW IS PER PROCESS, which is why it is no longer the default
 * (MOTIR-2037). On a multi-instance deployment each instance would enforce its
 * own window and the effective ceiling would be `limit × instances` — `× 2` on
 * today's Fly pool, and double again the day that pool grows. It survives as
 * the deliberate `MOTIR_RATE_LIMIT_STORE=memory` arm (`lib/rateLimit/store.ts`):
 * a single-instance self-host, where per-process and shared are the same thing,
 * and a test that wants a counter it can throw away. What replaced it as the
 * default is a SHARED store behind this same interface — no route, no header
 * and no status changed with it, which is what the interface was for.
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

let storeOverride: RateLimitStore | undefined;

/**
 * The store this process counts through.
 *
 * Resolved per call rather than at module load, and DEFAULTING to the shared
 * store (MOTIR-2037) — the same one `lib/rateLimit/store.ts` hands the app-level
 * limiters, so `/api/v1` and the auth / public-write / AI surfaces write to ONE
 * counter rather than two implementations of the same idea. Sharing the store is
 * not sharing the ceiling: v1 keeps its own `MOTIR_API_V1_RATE_LIMIT` budget
 * (ADR §6 of `production-service-stack.md`).
 *
 * Lazily, because `sharedRateLimitStore()` reads `MOTIR_RATE_LIMIT_STORE` and
 * `DATABASE_URL` to pick a backend: resolving that at import time would freeze
 * the answer before a test — or a `dotenv` load — had set either.
 */
function activeStore(): RateLimitStore {
  return storeOverride ?? sharedRateLimitStore();
}

/**
 * Pin a specific store, overriding the shared default.
 *
 * The seam a test uses to force the failure arms (a store that throws, a store
 * that hangs). Production installs nothing here — the default IS the shared
 * store, so there is no wiring step a deployment can forget.
 */
export function setRateLimitStore(store: RateLimitStore): void {
  storeOverride = store;
}

/**
 * Install a FRESH in-process counter — the test-isolation primitive.
 *
 * ⚠️ Deliberately not "drop the override and fall back to the default": the
 * ~40 suites that call this in a `beforeEach` do so to start from an EMPTY
 * counter, and emptiness is a property the shared store cannot offer by
 * swapping an object — its rows live in Postgres and outlive any reference to
 * it. Handing back a fresh Map keeps that guarantee exactly as it was, so those
 * suites are unaffected by the default moving. A test that means to exercise
 * the shared store simply does not call this (see
 * `tests/api/v1/shared-store.test.ts`).
 */
export function resetRateLimitStore(): void {
  storeOverride = createInProcessRateLimitStore();
}

/**
 * Test-only: drop whatever was pinned, so the next request resolves the SHARED
 * default again — the state a freshly-started process is in.
 *
 * `resetRateLimitStore` cannot serve this purpose: it pins the in-process
 * counter on purpose (see above), so a suite that used it to clean up after a
 * throwing-store test would silently spend the rest of its assertions off the
 * shared store it meant to be proving.
 */
export function __useDefaultRateLimitStoreForTest(): void {
  storeOverride = undefined;
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
    used = await activeStore().increment(fingerprint, windowStart, windowMs);
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
