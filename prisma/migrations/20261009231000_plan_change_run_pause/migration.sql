-- The planner's mid-run PAUSE (Story MOTIR-7990 · MOTIR-8007).
--
-- One table, `plan_change_run_pauses`, holding the ONE open pause a running
-- planning job records for its conversation: a `replan` (the START OVER offer) or an
-- `unclear` (a question). Plus two NULLABLE columns on `plan_change_mailbox_entry`
-- (`declines_pause_id`, `answers_pause_id`) marking the `fold` turn that declines an
-- offer or answers a question. No back-fill: a null reads exactly as before.
--
-- The CHECKs keep `kind` to its two values and make the text field exactly the
-- kind's own (`reason` iff replan, `question` iff unclear). They are invisible to
-- Prisma's differ, so `migrate diff` stays clean.

-- AlterTable
ALTER TABLE "plan_change_mailbox_entry" ADD COLUMN     "answers_pause_id" TEXT,
ADD COLUMN     "declines_pause_id" TEXT;

-- CreateTable
CREATE TABLE "plan_change_run_pauses" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "change_turn_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT,
    "question" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answer" TEXT,
    "answered_at" TIMESTAMP(3),
    "answered_by_id" TEXT,
    "reply_text" TEXT,
    "mailbox_entry_id" TEXT,
    "delivery_refused_code" TEXT,

    CONSTRAINT "plan_change_run_pauses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_change_run_pauses_session_id_job_id_created_at_idx" ON "plan_change_run_pauses"("session_id", "job_id", "created_at");

-- CreateIndex
CREATE INDEX "plan_change_run_pauses_workspace_id_idx" ON "plan_change_run_pauses"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_change_run_pauses_session_id_job_id_idempotency_key_key" ON "plan_change_run_pauses"("session_id", "job_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "plan_change_run_pauses" ADD CONSTRAINT "plan_change_run_pauses_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_change_run_pauses" ADD CONSTRAINT "plan_change_run_pauses_session_id_workspace_id_fkey" FOREIGN KEY ("session_id", "workspace_id") REFERENCES "plan_change_session"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_change_run_pauses" ADD CONSTRAINT "plan_change_run_pauses_answered_by_id_fkey" FOREIGN KEY ("answered_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CHECK: `kind` is one of the two pauses, and its text field is exactly its own.
ALTER TABLE "plan_change_run_pauses"
  ADD CONSTRAINT "plan_change_run_pauses_kind_check" CHECK ("kind" IN ('replan', 'unclear')),
  ADD CONSTRAINT "plan_change_run_pauses_text_matches_kind_check" CHECK (
    ("kind" = 'replan' AND "reason" IS NOT NULL AND "question" IS NULL)
    OR ("kind" = 'unclear' AND "question" IS NOT NULL AND "reason" IS NULL)
  ),
  ADD CONSTRAINT "plan_change_run_pauses_answer_check" CHECK (
    "answer" IS NULL OR "answer" IN ('start_over', 'apply', 'replied')
  );

-- ===========================================================================
-- Row-level security — plan_change_run_pauses
-- ===========================================================================
-- The SAME single PERMISSIVE FOR ALL policy `plan_change_mailbox_entry` carries
-- (and the composite FK above is the layer beneath it): USING + WITH CHECK against
-- current_setting('app.workspace_id', true), ENABLE + FORCE.
ALTER TABLE "plan_change_run_pauses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_change_run_pauses" FORCE ROW LEVEL SECURITY;

CREATE POLICY "plan_change_run_pauses_active_workspace" ON "plan_change_run_pauses"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
