-- EVENT-LEVEL IDEMPOTENCY ON THE POSTGRES ENGINE (Story MOTIR-3415 · MOTIR-3459)
--
-- `defineJob`'s `idempotency` option has been declared by `email.send` and
-- forwarded to Inngest since Story 1.6, and the engine never implemented it:
-- `job_event.idempotency_key` was written on every event and read by nothing.
-- This is the column and the constraint that make it real.

-- The resolved key, denormalised onto the queue row at enqueue. NULL for every
-- job declaring no template, and for an event carrying no value for it.
ALTER TABLE "job_queue" ADD COLUMN "idempotency_key" TEXT;

-- ⚠️ DEDUP BY CONSTRAINT, NOT BY CHECK-THEN-INSERT. Two concurrent identical
-- sends would both read "no prior row" and both insert; the race is two clicks
-- on one button. The dispatcher already applies exactly this pattern to its
-- `(event_id, job_id)` constraint and treats P2002 as "already enqueued".
--
-- PARTIAL, because only a non-NULL key should collide: a plain unique would
-- constrain every job that never fills the column.
--
-- ⚠️ RAW SQL BECAUSE PRISMA'S `@@unique` TAKES NO `WHERE`. That is normally a
-- drift trap in this repository (see `CLAUDE.md` § Migrations and the claim
-- index's own note in `schema.prisma`): the differ pairs indexes BY COLUMN LIST
-- and reports an inexpressible one as a permanent spurious RENAME — but only
-- once a datamodel index claims the same columns. Nothing on `JobQueueRun`
-- claims `(job_id, idempotency_key)`, so this index is ignored by the differ
-- rather than mis-paired, and `prisma migrate diff` reports no drift.
CREATE UNIQUE INDEX "job_queue_job_idempotency_key"
    ON "job_queue" ("job_id", "idempotency_key")
 WHERE "idempotency_key" IS NOT NULL;
