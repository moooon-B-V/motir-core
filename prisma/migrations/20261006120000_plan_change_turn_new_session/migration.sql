-- MOTIR-7649 — Plan something new (`docs/decisions/conversation-turn-intent.md`
-- AMENDMENT 3 · A3.1 / A3.2). The conversation's fifth turn intent, `new_session`
-- (a request to plan something new, which `ask_project` redirects and for which
-- no job runs), and the fixed confirm core writes for it: an `assistant` turn
-- marked by the new nullable `confirm` column.
--
-- Additive: no row is rewritten, and nothing in THIS transaction uses the new
-- enum value. RLS: `plan_change_turn` already carries its policies, so none is
-- added.

-- AlterEnum
ALTER TYPE "plan_change_turn_intent" ADD VALUE 'new_session';

-- CreateEnum
CREATE TYPE "plan_change_turn_confirm" AS ENUM ('new_session');

-- AlterTable
ALTER TABLE "plan_change_turn" ADD COLUMN     "confirm" "plan_change_turn_confirm";
