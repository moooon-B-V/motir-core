-- Automatic resume after a lost planning machine (Story MOTIR-8301 · MOTIR-8305).
-- How many times Motir resumed a conversation by itself, and when it last did.
ALTER TABLE "plan_change_session" ADD COLUMN "auto_resume_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "plan_change_session" ADD COLUMN "last_auto_resumed_at" TIMESTAMP(3);

ALTER TABLE "plan_change_session"
  ADD CONSTRAINT "plan_change_session_auto_resume_count_nonneg" CHECK ("auto_resume_count" >= 0);
