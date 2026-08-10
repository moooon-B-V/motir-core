-- ===========================================================================
-- rate_limit_counter — the SHARED rate-limit store (MOTIR-1165)
-- ===========================================================================
-- WHY THIS EXISTS. `lib/api/v1/rateLimit.ts` ships a `RateLimitStore` interface
-- whose only implementation is an in-process `Map`, so on a multi-instance
-- deployment each instance enforces its own window and the effective ceiling is
-- `limit x instances`. This table is the shared backend that fixes it, pinned in
-- `docs/decisions/production-service-stack.md` §6.
--
-- The increment is ONE statement and it is ATOMIC:
--   INSERT ... ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
--   RETURNING count
-- Read -> compare -> write is the textbook check-then-write race: two concurrent
-- requests both read the stale count and both pass, so the limit leaks under
-- exactly the concurrent load it exists to control. The comparison happens on
-- the value the statement returned, never on a value read before it.
--
-- `window_start` is UNIX MILLISECONDS and part of the primary key, so a new
-- window is a NEW ROW rather than a mutation of the old one. That is what makes
-- the window reset with no reset job; `expires_at` is what makes the old rows
-- collectable (the daily `system.rate-limit-sweep` job).
--
-- ---------------------------------------------------------------------------
-- ⚠️ NO `workspace_id` AND NO RLS — DELIBERATE, NOT AN OVERSIGHT (ADR §7)
-- ---------------------------------------------------------------------------
-- motir-core's standing contract is that every workspace-scoped table carries a
-- non-null `workspace_id` and ships its RLS policy in the same migration ("no
-- unguarded window"). This table is deliberately OUTSIDE that contract, for
-- three structural reasons — written down here because a table that silently
-- lacks `workspace_id` and RLS is indistinguishable from one that FORGOT, and a
-- reviewer reading the absence as an oversight will either "fix" it (breaking
-- the pre-auth path) or file a security finding against it:
--
--   1. THE LIMITED SURFACES HAVE NO TENANT YET. Sign-in, sign-up, password
--      reset and the public-write endpoints are rate-limited BEFORE any
--      workspace is known — that is the whole point of limiting them. A
--      `workspace_id NOT NULL` column would be unfillable on exactly the
--      requests that need the limiter most.
--   2. AN RLS POLICY WOULD DENY THOSE WRITES OUTRIGHT. A policy reading
--      `current_setting('app.workspace_id')` cannot be satisfied on a pre-auth
--      request, which turns a protection into an outage on the pre-auth path.
--   3. THE KEY HOLDS NO TENANT CONTENT. Every caller component composed into
--      `key` is SHA-256 hashed (`lib/rateLimit/keys.ts`) — an IP address is
--      personal data under GDPR and these surfaces key on IP — so the table
--      holds opaque, short-lived strings rather than a log of who tried to sign
--      in from where. There is nothing here for a tenancy boundary to protect.
--
-- The `motir_app` runtime role reaches this table through the schema-wide
-- ALTER DEFAULT PRIVILEGES grant (asserted as a totality by
-- `tests/app-role-identity.test.ts`), so no explicit GRANT is needed.
-- ===========================================================================

CREATE TABLE "rate_limit_counter" (
    "key" TEXT NOT NULL,
    "window_start" BIGINT NOT NULL,
    "count" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_counter_pkey" PRIMARY KEY ("key","window_start")
);

-- The sweep's only access path: delete every row whose window has passed.
CREATE INDEX "rate_limit_counter_expires_at_idx" ON "rate_limit_counter"("expires_at");
