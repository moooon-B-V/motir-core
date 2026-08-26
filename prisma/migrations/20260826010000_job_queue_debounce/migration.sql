-- THE ENGINE'S DEBOUNCE (Story MOTIR-3417 · MOTIR-3483)
--
-- `defineJob`'s `debounce` option has been declared by
-- `system.code-graph-refresh` and forwarded to Inngest since MOTIR-893, and the
-- engine never implemented it: the dispatcher wrote `run_at = now()` for every
-- subscriber, unconditionally. These are the two columns and the constraint that
-- make it real, and `docs/decisions/job-queue-foundation.md` §9 is the decision
-- they implement — "a `run_at` that is pushed forward on each same-key arrival,
-- which is a column and an upsert on a table we own, not a subsystem."

-- The coalescing key, resolved from the job's `debounce.key` expression at
-- enqueue. NULL for every job declaring no debounce, for an event that carries
-- no value for the expression, and — deliberately — for every row a worker has
-- CLAIMED. See the model comment: clearing it at the claim is what makes a
-- same-key push during a run enqueue a NEW run, and what keeps a retry's
-- `rescheduleAt` from colliding with that new row.
ALTER TABLE "job_queue" ADD COLUMN "debounce_key" TEXT;

-- When this row's window first opened. Stamped once and never moved, so
-- `debounce.timeout` caps TOTAL deferral rather than the gap since the last
-- arrival. MOTIR-2994 measured that Inngest's own cap does not fire under a
-- stream faster than ~1 event/second; ours is measured from this column and
-- therefore does.
ALTER TABLE "job_queue" ADD COLUMN "debounce_first_seen_at" TIMESTAMP(3);

-- ⚠️ COALESCE BY CONSTRAINT, NOT BY CHECK-THEN-INSERT — for a reason one step
-- stronger than the idempotency index beside it. The enqueue path DOES take a
-- row lock (`SELECT … FOR UPDATE` on the pending candidate) before it repoints
-- one, per CLAUDE.md's lock-before-a-contended-update contract. But a lock is a
-- lock on a ROW, and two concurrent first arrivals for one key have no row to
-- lock: both read the empty set and both insert. This index is what turns that
-- into a recoverable `P2002` the loser answers by coalescing into the winner,
-- rather than into two pending runs and two billed container sets.
--
-- PARTIAL on BOTH predicates, and each earns its place:
--   * `debounce_key IS NOT NULL` — a plain unique would constrain every job that
--     never fills the column.
--   * `state = 'pending'` — the window belongs to a pending row. It is
--     redundant while the claim clears the key (which it does), and it is kept
--     as the second lock on the retry hazard the model comment describes: a
--     `pending → running → pending` row must never collide with the row a push
--     enqueued while it was running.
--
-- ⚠️ RAW SQL BECAUSE PRISMA'S `@@unique` TAKES NO `WHERE`, and safe from the
-- drift trap CLAUDE.md § Migrations records for exactly the stated reason rather
-- than by luck: the differ pairs a database index to a datamodel index BY COLUMN
-- LIST, and NO `@@index` / `@@unique` on `JobQueueRun` claims
-- `(job_id, debounce_key)`. With nothing to pair against, an index carrying a
-- `WHERE` the differ cannot express is ignored instead of being reported as a
-- spurious rename.
CREATE UNIQUE INDEX "job_queue_job_debounce_key"
    ON "job_queue" ("job_id", "debounce_key")
 WHERE "debounce_key" IS NOT NULL AND "state" = 'pending';
