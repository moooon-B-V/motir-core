-- THE PER-POLL STATE OF ONE SUPERVISION (Story MOTIR-3778 · Subtask MOTIR-3826).
--
-- `docs/decisions/job-queue-foundation.md` §16 decides the shape this table
-- implements. The short version, because a migration is read by whoever is
-- surprised by it:
--
-- A container supervisor stops being a `while` loop inside ONE run and becomes
-- a state machine over RUNS: each pass does exactly one poll and DEFERS its own
-- `job_queue` row forward (`lib/jobs/engine/defer.ts`), so the worker slot is
-- free between polls. A deferred pass re-enters the handler FROM THE TOP with
-- nothing checkpointed, so whatever the supervision OBSERVED has to live
-- somewhere durable — and that somewhere may not be the step ledger.
--
-- ⚠️ WHY NOT `job_step`. A `step.run` under a fixed id memoizes its FIRST answer
-- for the life of the run. §13.3(b) rejected `index-started:<pid>` by name for
-- exactly that: an observation taken before the container started would pin
-- `null` for ever. Per-pass state is precisely the state that must CHANGE, which
-- is the one thing a memo cannot do.
--
-- ⚠️ WHY NOT THE QUEUE ROW'S PAYLOAD. `job_queue` has no payload column — the
-- payload is `job_event.data`, and one event fans out to every subscribing job's
-- run. A per-poll write there is a write into state another job's run is
-- reading, and into the payload the dead-letter queue replays from.
--
-- ⚠️ WHY NOT AN EXISTING FLEET ROW. `ci_runner_provisioning_intent` is durable
-- per CI intent; the index fleet has no per-dispatch row at all
-- (`ci_fleet_admission_lock` is a lock scope and `fleet_in_flight_slot` is a
-- capacity slot). One shared table is what makes the two conversions the SAME
-- conversion instead of two shapes kept in agreement by hand.
--
-- ⚠️ ONE ROW PER (RUN, SUBJECT), NOT PER RUN. `runIndexFleetSteps` fans out over
-- `target.projectIds` — one container per (repo × project) — so a supervision is
-- a SET whose degenerate case is one. `subject` is the projectId for the index
-- fleet and the intent id for the CI fleet, and it is also what builds the step
-- ids a sweep reads a session back out of (`index-boot:<subject>`).
--
-- ⚠️ WHAT IT DELIBERATELY DOES NOT HOLD: the container handle, `booted_at`,
-- `queued_at`, the credential expiry, the admission ticket and the slot ref.
-- Those ride `index-boot:<pid>`'s / `boot-runner`'s memo, which is what buys
-- re-attachment after a worker restart TODAY — copying them here would create a
-- second source of truth for the one fact whose second copy costs a billed
-- container. Anything derivable from those two is not a column either: the CI
-- fleet's `bootLatencyMs` is `started_at − session.queuedAt`.
--
-- Nothing reads or writes this table in this migration's own change. Its first
-- consumer is the supervision driver (MOTIR-3827) and its second is the
-- abandoned-supervision sweep (MOTIR-3830).

-- CreateEnum
-- A CLOSED three-member lifecycle, so an enum rather than TEXT: §16.4 makes the
-- terminal transition an invariant with three named entrances, and a fourth
-- member is a change to that invariant which should cost a migration and a
-- reader. (`kind` is TEXT for the opposite reason — a third supervisor should be
-- a registry edit, exactly as `fleet_in_flight_slot.workload` is.)
CREATE TYPE "job_supervision_state" AS ENUM ('watching', 'settling', 'settled');

-- CreateTable
CREATE TABLE "job_supervision" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "poll_number" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "consecutive_read_failures" INTEGER NOT NULL DEFAULT 0,
    "next_poll_at" TIMESTAMP(3) NOT NULL,
    "state" "job_supervision_state" NOT NULL DEFAULT 'watching',
    "workspace_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_supervision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- THE identity. Two projects of one index run hold two rows, and a second write
-- for the same pair is a constraint violation rather than a silent overwrite.
CREATE UNIQUE INDEX "job_supervision_run_id_subject_key" ON "job_supervision"("run_id", "subject");

-- CreateIndex
-- THE SWEEP'S READ: `WHERE state = 'watching' AND next_poll_at < $1`.
--
-- ⚠️ A PLAIN INDEX, NOT A PARTIAL ONE ON `next_poll_at WHERE state = 'watching'`
-- — which would be marginally tighter and would step into the trap CLAUDE.md
-- § Migrations records: Prisma's differ pairs indexes BY COLUMN LIST and cannot
-- express a `WHERE`, so a partial index sharing its columns with an `@@index` on
-- the same model is reported as a permanent spurious RENAME that the next
-- `migrate dev` writes into a migration. This table holds one row per LIVE
-- supervision (they are deleted at teardown), so the difference cannot pay for a
-- standing drift hazard.
CREATE INDEX "job_supervision_state_next_poll_at_idx" ON "job_supervision"("state", "next_poll_at");

-- AddForeignKey
-- Both FKs are modelled as a `@relation` on BOTH sides in `schema.prisma`
-- (CLAUDE.md § Migrations: a raw-SQL-only FK puts the datamodel and the
-- migration-built database in permanent drift, and every later `migrate dev`
-- re-proposes dropping it).
ALTER TABLE "job_supervision" ADD CONSTRAINT "job_supervision_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "job_queue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_supervision" ADD CONSTRAINT "job_supervision_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — job_supervision
-- ===========================================================================
-- The SAME gate as `job_event` / `job_queue` / `job_step`, over the same
-- denormalised column, deliberately: a supervision row is derived from the run
-- that produced it, so it is guarded exactly as that run is. The system-admin
-- branch is what lets the worker (which binds no workspace context) reach the
-- untenanted system-job rows; the workspace branch is what a member reading an
-- operator surface sees.
--
-- `FOR ALL` with both `USING` and `WITH CHECK` gives all four verbs, which
-- `tests/tenant-root-creation-rls.test.ts`'s totality guard asserts for every
-- RLS-enabled table.
--
-- No explicit GRANT is needed: `20260527134009_add_workspace_rls`'s
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public` grants the non-bypass application
-- role on every table created in this schema afterwards, which is the same
-- reason every table migration since has said so.
ALTER TABLE "job_supervision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_supervision" FORCE ROW LEVEL SECURITY;

CREATE POLICY "job_supervision_workspace_or_system_admin" ON "job_supervision"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
