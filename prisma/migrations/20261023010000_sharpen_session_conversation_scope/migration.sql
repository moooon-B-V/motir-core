-- Grill me on a CONVERSATION (Story MOTIR-9221 · Subtask MOTIR-9314). A Sharpen
-- session can now grill a plan-change conversation that has no plan yet, and the
-- WORK-ITEM target is retired: Motir AI does not edit a card as if it were the
-- person, and a grilling can span several targets, so there is no one card to
-- write its answers onto. The session's targets end as two: a plan, or a
-- conversation.
--
-- Pre-launch: there are no tenants to keep, so any `work_item`-scope session is
-- deleted (its turns cascade) rather than migrated.
--
-- The new FK is a Prisma `@relation` on both sides (`SharpenSession.planChangeSession`
-- ↔ `PlanChangeSession.sharpenSessions`), with the same actions as below. The
-- one-open-session index is partial, so it is deliberately NOT an `@@unique`, and
-- its column list `(created_by_id, plan_change_session_id)` is not the
-- `@@index([planChangeSessionId])` one (the partial-index rule). RLS needs nothing
-- new: `sharpen_session_active_workspace` gates every row on `workspace_id`.

DELETE FROM "sharpen_session" WHERE "scope_kind" = 'work_item';

-- The work-item target goes.
ALTER TABLE "sharpen_session" DROP CONSTRAINT "sharpen_session_scope_check";
DROP INDEX "sharpen_session_open_work_item_key";
ALTER TABLE "sharpen_session" DROP CONSTRAINT "sharpen_session_work_item_id_fkey";
DROP INDEX "sharpen_session_work_item_id_idx";
ALTER TABLE "sharpen_session" DROP COLUMN "work_item_id";

-- AlterEnum: `work_item` out, `conversation` in.
CREATE TYPE "sharpen_scope_kind_new" AS ENUM ('plan', 'conversation');
ALTER TABLE "sharpen_session" ALTER COLUMN "scope_kind" TYPE "sharpen_scope_kind_new"
  USING ("scope_kind"::text::"sharpen_scope_kind_new");
ALTER TYPE "sharpen_scope_kind" RENAME TO "sharpen_scope_kind_old";
ALTER TYPE "sharpen_scope_kind_new" RENAME TO "sharpen_scope_kind";
DROP TYPE "sharpen_scope_kind_old";

-- The conversation target.
ALTER TABLE "sharpen_session" ADD COLUMN "plan_change_session_id" TEXT;

-- CreateIndex
CREATE INDEX "sharpen_session_plan_change_session_id_idx" ON "sharpen_session"("plan_change_session_id");

-- AddForeignKey
ALTER TABLE "sharpen_session" ADD CONSTRAINT "sharpen_session_plan_change_session_id_fkey" FOREIGN KEY ("plan_change_session_id") REFERENCES "plan_change_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one target, and it matches the scope kind.
ALTER TABLE "sharpen_session" ADD CONSTRAINT "sharpen_session_scope_check" CHECK (
  ("scope_kind" = 'plan' AND "plan_id" IS NOT NULL AND "plan_change_session_id" IS NULL)
  OR ("scope_kind" = 'conversation' AND "plan_change_session_id" IS NOT NULL AND "plan_id" IS NULL)
);

-- ONE OPEN session per person per conversation (the plan one is unchanged).
CREATE UNIQUE INDEX "sharpen_session_open_conversation_key" ON "sharpen_session"("created_by_id", "plan_change_session_id")
  WHERE "status" = 'open';
