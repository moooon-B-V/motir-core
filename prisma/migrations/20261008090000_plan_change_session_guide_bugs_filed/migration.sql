-- Story MOTIR-7797 · MOTIR-7800 (decision MOTIR-7798 Q3): the per-conversation
-- bound on a guide's `file_bug` action. A scalar counter with no foreign key,
-- read and incremented under the session's row lock in the filing transaction.
-- A constant default, so the column is added without a table rewrite.
ALTER TABLE "plan_change_session" ADD COLUMN "guide_bugs_filed" INTEGER NOT NULL DEFAULT 0;
