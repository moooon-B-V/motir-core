-- The PLANNER's turn in the plan-change thread (MOTIR-2226), consuming
-- MOTIR-2222's producer half.
--
-- Purely ADDITIVE: a new enum member plus two columns that every existing row
-- already satisfies (`question` nullable, `is_answer` defaulted). No existing
-- `user` / `system` turn changes value, and the composite
-- `(session_id, workspace_id)` FK + the RLS shape are deliberately untouched —
-- the cross-tenant DoS that FK records is not something an enum member has any
-- reason to reopen.

-- AlterEnum
ALTER TYPE "plan_change_turn_role" ADD VALUE 'assistant';

-- AlterTable
ALTER TABLE "plan_change_turn"
  ADD COLUMN "question" TEXT,
  ADD COLUMN "is_answer" BOOLEAN NOT NULL DEFAULT false;
