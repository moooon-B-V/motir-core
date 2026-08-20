-- A conversation turn's INTENT, its correction flag, and an answer's CITATIONS
-- (Story MOTIR-1343 · MOTIR-1818; contract in
-- `docs/decisions/conversation-turn-intent.md`, decided by MOTIR-1816).
--
-- Purely ADDITIVE to `plan_change_turn`. Every existing row keeps its meaning:
-- the shipped plan-change thread wrote `user` turns whose intent was implicit,
-- and they stay NULL rather than being back-filled to `plan_change` — a
-- back-fill would assert a classification that never ran, and NULL already reads
-- correctly as "this turn predates the intent model".
--
-- ⚠️ NO RLS STANZA ACCOMPANIES THIS ONE, and that is deliberate rather than an
-- omission. RLS is a TABLE-level policy and `plan_change_turn` already carries
-- it (the workspace-RLS migration, plus the composite FK to
-- `(session_id, workspace_id)` that makes a cross-tenant turn nonexistent rather
-- than merely invisible). Adding a column to a policed table inherits the
-- policy; there is no new table, and a new policy here would be a second place
-- for the tenancy rule to drift. The regression to guard against is a later
-- migration adding a citations SIDE TABLE without one.

-- CreateEnum
CREATE TYPE "plan_change_turn_intent" AS ENUM ('plan_change', 'ask');

-- AlterTable: the intent a `user` turn ran under, and whether it was corrected.
-- Nullable by design — `system` and `assistant` turns have no intent of their
-- own, the same shape `author_id` already takes on this table.
ALTER TABLE "plan_change_turn" ADD COLUMN "intent" "plan_change_turn_intent";
ALTER TABLE "plan_change_turn" ADD COLUMN "intent_corrected" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: the work items an ANSWER rests on, as identifiers in citation
-- order. A text array rather than a child table or an FK set, for the reason
-- `plan_change_session.target_keys` records for itself: a deleted work item must
-- not cascade away the answer that cited it. Validated at write time against the
-- project's own items, so an unresolvable or cross-project key never lands here.
ALTER TABLE "plan_change_turn" ADD COLUMN "citations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
