import { createInProcessRateLimitStore, type RateLimitStore } from '@/lib/api/v1/rateLimit';
import { createPostgresRateLimitStore } from '@/lib/rateLimit/postgresStore';

// WHICH store backs every limiter in this deployment (Subtask 8.5.9 /
// MOTIR-1165) — resolved once, from the environment, and pinned in
// `docs/decisions/production-service-stack.md` §6.
//
// There is exactly ONE store implementation per backend in the repo and this
// module is what chooses between them:
//   `postgres` → `createPostgresRateLimitStore` (lib/rateLimit/postgresStore.ts)
//   `memory`   → `createInProcessRateLimitStore` (lib/api/v1/rateLimit.ts)
// The `memory` arm REUSES the store that already ships rather than adding a
// second in-process Map — the point of the shared interface.
//
// ── SELF-HOSTING ─────────────────────────────────────────────────────────────
// There is no vendor env to leave unset: the store is the application's own
// database, so a self-hoster gets the shared limiter for free wherever
// `DATABASE_URL` is set. The escape hatch is `MOTIR_RATE_LIMIT_STORE=memory`, for
// a single-instance install that would rather not write (where per-process and
// shared are the same thing anyway) and for tests. Budgets stay separately
// env-configurable (`lib/rateLimit/budgets.ts`); sharing the store is not
// sharing the ceiling.
//
// ⚠️ `redis` IS NOT AN ACCEPTED VALUE, and an unrecognised value THROWS rather
// than falling back. Naming an alternative in a decision record is not the same
// as building it, and a silent fallback is the dangerous failure here: a typo'd
// or aspirational value would quietly return the deployment to per-process
// counters with a ceiling of `limit x instances` — the exact defect this table
// was added to fix — while every log line and header still claimed the limit was
// being enforced. Failing loudly at the first limited request is the cheaper
// half of that trade.

/** The store backends this build accepts. */
export type RateLimitBackend = 'postgres' | 'memory';

/** The env var that selects the backend. */
export const RATE_LIMIT_STORE_ENV = 'MOTIR_RATE_LIMIT_STORE';

const ACCEPTED_BACKENDS: readonly RateLimitBackend[] = ['postgres', 'memory'];

/** Raised for an env value this build cannot honour (notably `redis`). */
export class UnknownRateLimitBackendError extends Error {
  constructor(value: string) {
    super(
      `${RATE_LIMIT_STORE_ENV}="${value}" is not a store this build accepts. ` +
        `Use one of: ${ACCEPTED_BACKENDS.join(', ')}.`,
    );
    this.name = 'UnknownRateLimitBackendError';
  }
}

/**
 * Which backend this process should use.
 *
 * Unset resolves to `postgres` wherever a `DATABASE_URL` exists and `memory`
 * where none does — so a build with no database (a unit test, a docs-only CI
 * job) keeps working without configuration, while every real deployment gets the
 * shared counter by default rather than by opting in.
 */
export function resolveRateLimitBackend(): RateLimitBackend {
  const raw = process.env[RATE_LIMIT_STORE_ENV]?.trim();
  if (!raw) return process.env['DATABASE_URL'] ? 'postgres' : 'memory';
  const normalized = raw.toLowerCase();
  if (!ACCEPTED_BACKENDS.includes(normalized as RateLimitBackend)) {
    throw new UnknownRateLimitBackendError(raw);
  }
  return normalized as RateLimitBackend;
}

let resolved: RateLimitStore | undefined;
let override: RateLimitStore | undefined;

/**
 * The store every app-level limiter writes through.
 *
 * Memoized: the backend is a property of the deployment, not of the request, and
 * re-reading the env on every request would let a mid-flight change split one
 * window across two backends.
 *
 * ⚠️ `/api/v1` still reads its store from its own `setRateLimitStore` seam,
 * which MOTIR-2037 (8.5.10) installs THIS implementation into — the second card
 * reuses the store, it does not add a parallel one.
 */
export function sharedRateLimitStore(): RateLimitStore {
  if (override) return override;
  resolved ??=
    resolveRateLimitBackend() === 'postgres'
      ? createPostgresRateLimitStore()
      : createInProcessRateLimitStore();
  return resolved;
}

/** Test-only: pin a fake store (a throwing / hanging one, for the fail-open cases). */
export function __setSharedRateLimitStoreForTest(store: RateLimitStore): void {
  override = store;
}

/** Test-only: drop the override AND the memo, so the next call re-reads the env. */
export function __resetSharedRateLimitStoreForTest(): void {
  override = undefined;
  resolved = undefined;
}
